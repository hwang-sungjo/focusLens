// LBE-3: fault injection only into this runner's disposable local Compose project.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureLocalEnv } = require('./local-env');

const repoRoot = path.resolve(__dirname, '../..');
const REQUEST_TIMEOUT_MS = 8000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Docker diagnostics, auth responses and SQL data must never reach the terminal.
async function command(program, args, { env, operation, signal }) {
  signal?.throwIfAborted();
  const grouped = program === process.execPath && process.platform !== 'win32';
  const child = spawn(program, args, {
    cwd: repoRoot, env, signal, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    if (output.length < 8 * 1024 * 1024) output += chunk.toString('utf8');
  });
  // Always consume private diagnostics to avoid blocking a child on a full pipe.
  child.stderr.on('data', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  const completed = new Promise((resolve, reject) => {
    child.once('error', error => reject(new Error(`${operation} could not start (${error.code || 'process error'}).`)));
    child.once('close', (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`${operation} failed (${killedBy || `exit ${code}`}).`));
    });
  });
  try {
    await completed;
  } catch (error) {
    const terminate = signalName => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (_error) { /* It may have exited between the check and the signal. */ }
    };
    terminate('SIGTERM');
    const forceKill = setTimeout(() => terminate('SIGKILL'), 1000);
    forceKill.unref();
    try { await closed; } finally { clearTimeout(forceKill); }
    throw error;
  }
  return output.trim();
}

function digest(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(
      Object.keys(item).sort().map(key => [key, canonical(item[key])]),
    );
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node backend/scripts/verify-local-recovery.js');
    console.log('Builds an isolated local stack and tests dependency outages, auth recovery and shutdown.');
    return;
  }
  assert.equal(args.length, 0, 'This runner accepts only --help and never targets an existing project.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-recovery-'));
  const project = `focuslens-recovery-${randomUUID()}`;
  const env = {
    ...process.env, COMPOSE_PROJECT_NAME: project,
    LOCAL_ENV_FILE: path.join(temporary, '.env'),
    LOCAL_API_PORT: '0', LOCAL_DB_PORT: '0', LOCAL_REDIS_PORT: '0',
    LOCAL_CORS_ORIGIN: 'http://localhost:5173', LOCAL_ROLLUP_ENABLED: 'true',
  };
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const compose = ['compose', '--project-directory', repoRoot, '-p', project,
    '-f', path.join(repoRoot, 'docker-compose.yml')];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let stage = 'prepare';
  let result;
  let cleanupError;
  let baseUrl;
  const progress = value => { stage = value; console.log(JSON.stringify({ stage })); };
  const run = (args, operation, extra = {}) => command('docker', args, {
    env, operation, signal: controller.signal, ...extra,
  });
  const node = (script, operation) => command(process.execPath, [script], {
    env, operation, signal: controller.signal,
  });
  const composeRun = (args, operation) => run([...compose, ...args], operation);
  const sql = query => composeRun([
    'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'focuslens', '-d', 'focuslens', '-Atc', query,
  ], 'Read isolated database');
  const locateOrigin = async () => {
    const address = await composeRun(['port', 'backend', '3000'], 'Find isolated API port');
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'API must bind to an isolated loopback port');
    baseUrl = `http://${address}`;
  };
  const request = async (route, { method = 'GET', body, token } = {}, expected = 200) => {
    controller.signal.throwIfAborted();
    const start = Date.now();
    let response;
    try {
      response = await fetch(baseUrl + route, {
        method,
        headers: {
          ...(body && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        ...(body && { body: JSON.stringify(body) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (_error) {
      throw new Error(`API ${method} request did not return within the recovery deadline.`);
    }
    assert.equal(response.status, expected, `API ${method} request returned unexpected status`);
    let envelope;
    try { envelope = await response.json(); } catch (_error) {
      throw new Error('API recovery response must be JSON.');
    }
    assert.ok(envelope && typeof envelope.data === 'object' && typeof envelope.error === 'string', 'API response envelope');
    assert.equal(envelope.success, expected < 400, 'API success flag matches status');
    assert.ok(expected < 400 ? envelope.error === '' : envelope.error.length > 0, 'API error field matches status');
    return { data: envelope.data, elapsed_ms: Date.now() - start };
  };
  const healthy = async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      try {
        const { data } = await request('/health');
        if (data.db === 'connected' && data.redis === 'connected') return;
      } catch (_error) { /* Dependencies can still be starting. */ }
      await delay(500);
    }
    throw new Error('Local API recovery timed out.');
  };
  const backendIdentity = async () => {
    const id = await composeRun(['ps', '-q', 'backend'], 'Find isolated backend');
    assert.match(id, /^[a-f0-9]+$/, 'Expected one isolated backend');
    const state = JSON.parse(await run(['inspect', '--format', '{{json .State}}', id], 'Read backend state'));
    return { id, started_at: state.StartedAt };
  };
  const sameBackend = async expected => assert.ok(digest(await backendIdentity()) === digest(expected),
    'Dependency recovery must not restart the API process');
  const shutdownEvents = async identity => {
    const logs = await run(['logs', '--since', identity.started_at, identity.id], 'Read isolated shutdown evidence');
    return logs.split('\n').flatMap(line => {
      try {
        const event = JSON.parse(line);
        return typeof event.event === 'string' && event.event.startsWith('server_shutdown_') ? [event] : [];
      } catch (_error) { return []; }
    });
  };
  const stopAndInspect = async label => {
    const identity = await backendIdentity();
    const start = Date.now();
    await composeRun(['stop', '--timeout', '15', 'backend'], `${label} backend shutdown`);
    const state = JSON.parse(await run(['inspect', '--format', '{{json .State}}', identity.id], 'Read stopped backend state'));
    assert.ok(state.Running === false && state.OOMKilled === false, `${label}: backend stopped without OOM`);
    assert.equal(state.ExitCode, 0, `${label}: backend exited gracefully`);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 15_000, `${label}: backend stopped within the grace period`);
    const events = await shutdownEvents(identity);
    // The shutdown service's final event confirms that each cleanup stage completed.
    assert.ok(events.some(event => event.event === 'server_shutdown_completed' && event.exit_code === 0),
      `${label}: structured shutdown completion`);
    const closed = events.filter(event => event.event === 'server_shutdown_resource_closed')
      .map(event => event.component);
    assert.ok(['http', 'rollup_scheduler', 'postgres', 'redis'].every(component => closed.includes(component)),
      `${label}: HTTP, scheduler, PostgreSQL and Redis cleanup completed`);
    return { graceful: true, elapsed_ms: elapsed, events: events.map(event => event.event) };
  };
  try {
    await ensureLocalEnv({ repoRoot, envFile: env.LOCAL_ENV_FILE });
    progress('build_isolated_stack_and_create_records');
    await node('backend/scripts/local-up.js', 'Build and start isolated local stack');
    await locateOrigin();
    await healthy();
    const unique = randomUUID();
    const credentials = { email: `recovery-${unique}@example.test`, password: randomBytes(24).toString('hex') };
    const { data: registered } = await request('/api/auth/register', {
      method: 'POST', body: { ...credentials, name: 'Recovery verification', nickname: `recovery-${unique.slice(0, 16)}` },
    }, 201);
    const { data: login } = await request('/api/auth/login', { method: 'POST', body: credentials });
    assert.ok(login.user_id === registered.user_id && login.access_token && login.refresh_token, 'Fixture login identifies the registered account');
    let activeToken = login.access_token;
    const { data: started } = await request('/api/sessions/start', { method: 'POST', token: activeToken }, 201);
    assert.match(started.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'Fixture session has a UUID v4');
    // Only this disposable fixture is backdated to test preservation of a scored report.
    await sql(`UPDATE sessions SET started_at = NOW() - INTERVAL '70 seconds' WHERE id = '${started.session_id}'`);
    await request(`/api/v2/sessions/${started.session_id}/log`, {
      method: 'POST', token: activeToken, body: {
        client_log_id: randomUUID(), measured_at: new Date(Date.now() - 5000).toISOString(),
        gaze: 85.5, blink: 72, head: 90, total: 79.65, face_detected: true,
      },
    });
    const { data: ended } = await request(`/api/sessions/${started.session_id}/end`, { method: 'POST', token: activeToken });
    assert.ok(ended.status === 'COMPLETED' && ended.report_id, 'Fixture session completed with a report');
    const reportRoute = `/api/reports/${started.session_id}`;
    const originalReportDigest = digest((await request(reportRoute, { token: activeToken })).data);
    const readPreservedReport = async () => assert.equal(
      digest((await request(reportRoute, { token: activeToken })).data), originalReportDigest,
      'Existing report survives dependency recovery',
    );

    const { data: loggedOut } = await request('/api/auth/register', {
      method: 'POST', body: {
        email: `logged-out-${unique}@example.test`, password: randomBytes(24).toString('hex'),
        name: 'Logout verification', nickname: `logout-${unique.slice(0, 16)}`,
      },
    }, 201);
    const loggedOutToken = loggedOut.access_token;
    await request('/api/auth/logout', { method: 'POST', token: loggedOutToken, body: { refresh_token: loggedOut.refresh_token } });
    await request('/api/users/me/privacy', { token: loggedOutToken }, 401);
    const initialBackend = await backendIdentity();

    progress('redis_outage_fails_closed_and_recovers_without_api_restart');
    await composeRun(['stop', '--timeout', '10', 'redis'], 'Stop isolated Redis');
    const redisOutageStart = Date.now();
    const redisHealth = await request('/health', {}, 503);
    assert.equal(redisHealth.data.redis, 'disconnected', 'Health identifies Redis outage');
    assert.equal(redisHealth.data.db, 'connected', 'PostgreSQL remains connected during Redis outage');
    const redisProtected = await request(reportRoute, { token: activeToken }, 503);
    const redisLogout = await request('/api/auth/logout', { method: 'POST', token: activeToken }, 503);
    await delay(Math.max(0, 6000 - (Date.now() - redisOutageStart)));
    await composeRun(['start', 'redis'], 'Restart isolated Redis with retained volume');
    await healthy();
    await sameBackend(initialBackend);
    await readPreservedReport();
    await request('/api/users/me/privacy', { token: loggedOutToken }, 401);

    progress('postgres_outage_returns_service_unavailable_and_recovers');
    await composeRun(['stop', '--timeout', '10', 'postgres'], 'Stop isolated PostgreSQL');
    const dbHealth = await request('/health', {}, 503);
    assert.equal(dbHealth.data.db, 'disconnected', 'Health identifies PostgreSQL outage');
    const dbProtected = await request(reportRoute, { token: activeToken }, 503);
    await composeRun(['start', 'postgres'], 'Restart isolated PostgreSQL with retained volume');
    await healthy();
    await sameBackend(initialBackend);
    await readPreservedReport();

    progress('recover_auth_after_redis_data_loss_in_maintenance');
    await composeRun(['stop', '--timeout', '15', 'backend'], 'Stop API before simulated Redis data loss');
    await composeRun(['exec', '-T', 'redis', 'redis-cli', 'FLUSHDB'], 'Clear only isolated Redis during maintenance');
    const oldEnvironmentHash = createHash('sha256').update(await fs.readFile(env.LOCAL_ENV_FILE)).digest('hex');
    await node('backend/scripts/recover-local-auth.js', 'Rotate auth credentials and recover isolated API');
    const newEnvironmentHash = createHash('sha256').update(await fs.readFile(env.LOCAL_ENV_FILE)).digest('hex');
    assert.notEqual(newEnvironmentHash, oldEnvironmentHash, 'Recovery replaces the signing secret');
    await locateOrigin();
    await healthy();
    await request(reportRoute, { token: activeToken }, 401);
    await request('/api/users/me/privacy', { token: loggedOutToken }, 401);
    await request('/api/auth/refresh', { method: 'POST', body: { refresh_token: login.refresh_token } }, 401);
    await request('/api/auth/refresh', { method: 'POST', body: { refresh_token: registered.refresh_token } }, 401);
    assert.equal(await sql('SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW()'),
      '0', 'Auth recovery revokes every previously active Refresh Token');
    const { data: recoveredLogin } = await request('/api/auth/login', { method: 'POST', body: credentials });
    assert.ok(recoveredLogin.access_token, 'New login succeeds after auth recovery');
    activeToken = recoveredLogin.access_token;
    await readPreservedReport();

    progress('graceful_shutdown_and_restart');
    const normalShutdown = await stopAndInspect('Healthy dependencies');
    await composeRun(['start', 'backend'], 'Restart isolated backend after graceful shutdown');
    await locateOrigin();
    await healthy();
    await readPreservedReport();

    progress('graceful_shutdown_with_dependencies_offline');
    await composeRun(['stop', '--timeout', '10', 'postgres', 'redis'], 'Stop isolated dependencies');
    await request('/health', {}, 503);
    const offlineShutdown = await stopAndInspect('Offline dependencies');
    result = {
      result: 'LBE-3 local recovery passed',
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      redis_outage: { health_status: 503, protected_status: 503, logout_status: 503,
        longest_request_ms: Math.max(redisHealth.elapsed_ms, redisProtected.elapsed_ms, redisLogout.elapsed_ms),
        api_restarted: false, logged_out_token_still_rejected: true },
      postgres_outage: { health_status: 503, protected_status: 503,
        longest_request_ms: Math.max(dbHealth.elapsed_ms, dbProtected.elapsed_ms), api_restarted: false },
      redis_data_loss_recovery: { maintenance_before_data_loss: true, previous_access_tokens_rejected: true,
        previous_refresh_token_rejected: true, new_login_succeeds: true },
      scored_report_preserved: true, report_sha256: originalReportDigest,
      normal_shutdown: normalShutdown, dependencies_offline_shutdown: offlineShutdown,
      original_services_untouched: true,
    };
  } catch (error) {
    throw new Error(`LBE-3 failed at ${stage}: ${error.message}`, { cause: error });
  } finally {
    try {
      await command('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], {
        env, operation: 'Remove isolated recovery project',
      });
    } catch (error) { cleanupError = error; }
    try {
      // Retain the private Compose environment if Docker cleanup needs a retry.
      if (!cleanupError) await fs.rm(temporary, { recursive: true, force: true });
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    if (cleanupError) throw new Error(
      `Recovery verification cleanup failed for ${project}; private environment retained at ${env.LOCAL_ENV_FILE}.`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ result: 'LBE-3 failed', error: error.message }));
    process.exitCode = 1;
  });
}
