// The HTTP, browser and local AI bridge checks each own a disposable Compose project.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ensureLocalEnv } = require('./local-env');
const { prepareHistory } = require('./tests/fe4-history.cjs');

const repoRoot = path.resolve(__dirname, '../..');
const PRIVATE_KEYS = new Set([
  'password', 'password_hash', 'access_token', 'refresh_token', 'credentials',
  'authorization', 'cookie', 'set-cookie', 'jwt_secret',
]);

const publicSummary = value => {
  if (Array.isArray(value)) return value.map(publicSummary);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, publicSummary(item)]),
  );
  return value;
};

function frontendOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === '/'
    && !url.search && !url.hash, 'LOCAL_FRONTEND_ORIGIN must be an explicit loopback HTTP origin with a port');
  return url.origin;
}

async function cameraProgress(directory) {
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, 'fe3-live-progress.json'), 'utf8'));
    const stages = ['opening_camera', 'calibration_started', 'calibration_retry', 'calibration_completed',
      'camera_measurement_started', 'minute_completed', 'minute_skipped'];
    if (!stages.includes(record.stage)) return null;
    const summary = { camera_stage: record.stage };
    for (const key of ['calibration_samples', 'minute_samples', 'emitted_minutes']) {
      if (Number.isSafeInteger(record[key]) && record[key] >= 0) summary[key] = record[key];
    }
    return summary;
  } catch { return null; }
}

async function availableBrowserOrigin() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return origin; // Vite later binds this exact port with strictPort before opening any pages.
}

async function checkRecoveryDatabase(sql, recovery) {
  const { session_id, report_id, minutes, avg_focus_score } = recovery;
  // Browser responses are untrusted. Only this validated session UUID enters the query.
  assert.match(session_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(minutes.length, 2);
  assert.equal(new Set(minutes.map(minute => minute.client_log_id)).size, 2);
  const persisted = JSON.parse(await sql(`SELECT json_build_object(
    'status', s.status,
    'minutes', (SELECT json_agg(json_build_object(
      'client_log_id', client_log_id, 'measured_ms', round(extract(epoch FROM measured_at AT TIME ZONE 'UTC') * 1000),
      'score', focus_score, 'gaze', gaze_score, 'blink', blink_score, 'head', head_score,
      'face_detected', face_detected, 'attention_state', attention_state) ORDER BY minute_index)
      FROM concentration_logs WHERE session_id = s.id),
    'reports', (SELECT json_agg(json_build_object('id', id, 'score', summary_json->'avg_focus_score',
      'total_logs', summary_json->'total_logs')) FROM reports WHERE session_id = s.id))
    FROM sessions s WHERE s.id = '${session_id}'`));
  assert.deepEqual(persisted, {
    status: 'COMPLETED',
    minutes: minutes.map(({ client_log_id, measured_at, score, gaze, blink, head, face_detected, attention_state }) =>
      ({ client_log_id, measured_ms: Date.parse(measured_at), score, gaze, blink, head, face_detected, attention_state })),
    reports: [{ id: report_id, score: avg_focus_score, total_logs: 2 }],
  }, 'Expected both original minutes and one completed report in PostgreSQL.');
  recovery.postgres_verified = true;
}

// Seed output contains known passwords. Docker diagnostics may contain secrets.
// Capture both streams and expose only a deliberately safe API summary.
async function command(program, args, { env, operation, signal, timeoutMs = 600_000 }) {
  signal?.throwIfAborted();
  const grouped = process.platform !== 'win32';
  let child;
  try {
    child = spawn(program, args, {
      cwd: repoRoot, env, signal, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_error) {
    throw new Error(`${operation} could not start.`);
  }
  const terminate = name => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (_error) { /* The process group may already have exited. */ }
  };
  let output = '';
  let diagnostics = '';
  let total = 0;
  let rejectOutput;
  const overflow = new Promise((_resolve, reject) => { rejectOutput = reject; });
  const consume = (chunk, stderr) => {
    total += chunk.length;
    if (total > 8 * 1024 * 1024) {
      rejectOutput(new Error(`${operation} produced too much private output.`));
      return;
    }
    if (stderr) diagnostics += chunk.toString('utf8');
    else output += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => consume(chunk, false));
  child.stderr.on('data', chunk => consume(chunk, true));
  const closed = new Promise(resolve => child.once('close', resolve));
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${operation} could not finish.`)));
    child.once('close', (code, killedBy) => resolve({ code, signal: killedBy }));
  });
  let deadline;
  const timedOut = new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`${operation} timed out.`)), timeoutMs);
    deadline.unref?.();
  });
  try {
    const state = await Promise.race([completed, timedOut, overflow]);
    signal?.throwIfAborted();
    return { ...state, output: output.trim(), diagnostics: diagnostics.trim() };
  } catch (error) {
    terminate('SIGTERM');
    const forceKill = setTimeout(() => terminate('SIGKILL'), 1000);
    forceKill.unref?.();
    try { await closed; } finally { clearTimeout(forceKill); }
    throw error;
  } finally { clearTimeout(deadline); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node backend/scripts/verify-handoff-stack.js [--browser | --fe3 [--live] | --fe4 [--live]]');
    console.log('Builds a separate local stack, seeds it, checks frontend API contracts, and removes only its own resources.');
    console.log('HTTP mode uses LOCAL_FRONTEND_ORIGIN (default http://localhost:5173). Browser mode uses two temporary loopback ports.');
    return;
  }
  const recoveryMode = args[0] === '--fe4';
  const bridgeMode = (recoveryMode || args[0] === '--fe3') && (args.length === 1 || (args.length === 2 && args[1] === '--live'));
  const browserMode = bridgeMode || (args.length === 1 && args[0] === '--browser');
  assert.ok(browserMode || args.length === 0, 'Expected no arguments, --browser, --fe3 [--live], or --fe4 [--live].');
  const label = recoveryMode ? 'FE-4 isolated product checks' : bridgeMode ? 'FE-3 isolated AI bridge checks'
    : browserMode ? 'FE-2 isolated browser checks' : 'LBE-5 isolated handoff checks';
  const origin = frontendOrigin(browserMode ? await availableBrowserOrigin()
    : process.env.LOCAL_FRONTEND_ORIGIN || 'http://localhost:5173');
  const project = `focuslens-handoff-${randomUUID()}`;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-handoff-'));
  const env = {
    ...process.env, COMPOSE_PROJECT_NAME: project,
    LOCAL_ENV_FILE: path.join(temporary, '.env'),
    LOCAL_API_PORT: '0', LOCAL_DB_PORT: '0', LOCAL_REDIS_PORT: '0',
    LOCAL_CORS_ORIGIN: origin, LOCAL_FRONTEND_ORIGIN: origin, LOCAL_ROLLUP_ENABLED: 'false',
    LOCAL_VERIFY_SEEDED: 'true',
  };
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const compose = ['compose', '--project-directory', repoRoot, '-p', project,
    '-f', path.join(repoRoot, 'docker-compose.yml')];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let stage = 'prepare_isolated_environment';
  let resourcesMayExist = false;
  let result;
  let failure;
  let apiSummary;
  let cleanupFailed = false;
  const progress = value => { stage = value; console.log(JSON.stringify({ stage })); };
  const run = async (program, args, operation, extra = {}) => {
    const outcome = await command(program, args, { env, operation, signal: controller.signal, ...extra });
    if (outcome.code !== 0) throw new Error(`${operation} failed.`);
    return outcome.output;
  };
  const composeRun = (args, operation, extra) => run('docker', [...compose, ...args], operation, extra);
  const sql = query => composeRun(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'focuslens', '-d', 'focuslens', '-Atc', query], 'Verify isolated database', { timeoutMs: 30_000 });
  const heartbeat = setInterval(() => console.log(JSON.stringify({ stage, waiting: true })), 30_000);
  heartbeat.unref?.();
  let progressTimer;
  try {
    await ensureLocalEnv({ repoRoot, envFile: env.LOCAL_ENV_FILE });
    controller.signal.throwIfAborted();
    progress('build_and_start_isolated_handoff_stack');
    resourcesMayExist = true;
    await run(process.execPath, [path.join(__dirname, 'local-up.js')], 'Isolated local startup');

    progress('verify_migrations_views_and_seed_accounts');
    const migrations = Number(await sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'));
    assert.equal(migrations, 11, 'Expected all 11 committed migrations in the new database');
    const views = Number(await sql("SELECT count(*) FROM information_schema.views WHERE table_schema='public' AND table_name LIKE 'v_%'"));
    assert.equal(views, 5, 'Expected all 5 query Views');
    await composeRun(['run', '--rm', '--no-deps', '--entrypoint', 'node', 'migrate', '/app/prisma/seed.js'],
      'Seed only the isolated database', { timeoutMs: 90_000 });
    if (recoveryMode) {
      progress('prepare_historical_reports_and_shared_feed');
      await prepareHistory({ project, sql, composeRun });
    }

    const address = await composeRun(['port', 'backend', '3000'], 'Find isolated API port', { timeoutMs: 30_000 });
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'Verification API must bind to an isolated loopback port');
    const verifyEnv = { ...env, LOCAL_VERIFY_URL: `http://${address}` };
    progress(recoveryMode ? 'verify_two_minutes_recovery_history_and_accessibility' : bridgeMode ? 'verify_browser_camera_queue_and_report'
      : browserMode ? 'verify_browser_auth_privacy_groups' : 'verify_frontend_cookie_privacy_and_group_contracts');
    const verifier = browserMode ? 'verify-frontend-browser.cjs' : 'verify-frontend-handoff.js';
    const verifierArgs = bridgeMode ? args : [];
    if (bridgeMode && args.includes('--live')) {
      let previous = '';
      progressTimer = setInterval(async () => {
        const summary = await cameraProgress(temporary);
        const current = JSON.stringify(summary);
        if (summary && current !== previous) console.log(current);
        previous = current;
      }, 1000);
      progressTimer.unref();
    }
    const checked = await command(process.execPath, [path.join(__dirname, verifier), ...verifierArgs], {
      env: verifyEnv, operation: label, signal: controller.signal, timeoutMs: recoveryMode ? 480_000 : browserMode ? 300_000 : 180_000,
    });
    try { apiSummary = publicSummary(JSON.parse(checked.output || checked.diagnostics)); }
    catch (_error) { throw new Error('Frontend checks did not return a JSON summary.'); }
    if (checked.code !== 0) throw new Error(label + ' failed.');
    if (recoveryMode) {
      progress('verify_both_persisted_minutes_and_report');
      await checkRecoveryDatabase(sql, apiSummary.checks.recovery);
    } else if (bridgeMode) {
      progress('verify_persisted_session_log_and_report');
      const measurement = apiSummary.checks.measurement;
      // IDs originate in browser responses. Validate before using them in this test query.
      for (const id of [measurement.session_id, measurement.client_log_id, measurement.report_id]) {
        assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      }
      const db = JSON.parse(await sql(`SELECT json_build_object(
        'status', s.status, 'log_count', (SELECT count(*) FROM concentration_logs WHERE session_id = s.id),
        'report_count', (SELECT count(*) FROM reports WHERE session_id = s.id),
        'score', l.focus_score, 'report_score', (r.summary_json->>'avg_focus_score')::float,
        'measured_ms', round(extract(epoch FROM l.measured_at AT TIME ZONE 'UTC') * 1000))
        FROM sessions s JOIN concentration_logs l ON l.session_id = s.id JOIN reports r ON r.session_id = s.id
        WHERE s.id = '${measurement.session_id}' AND l.client_log_id = '${measurement.client_log_id}'
          AND r.id = '${measurement.report_id}'`));
      assert.deepEqual(db, {
        status: 'COMPLETED', log_count: 1, report_count: 1, score: measurement.score,
        report_score: measurement.score, measured_ms: Date.parse(measurement.measured_at),
      }, 'Expected the original measured minute and one completed report in PostgreSQL.');
      measurement.postgres_verified = true;
    }
    result = {
      result: label + ' passed', frontend_origin: origin,
      migrations, query_views: views, seed_completed: true,
      [browserMode ? 'browser_checks' : 'api_checks']: apiSummary, original_services_untouched: true,
    };
  } catch (error) {
    failure = { result: label + ' failed', stage, error: error.message,
      ...(apiSummary && { [browserMode ? 'browser_checks' : 'api_checks']: apiSummary }) };
  } finally {
    clearInterval(heartbeat);
    clearInterval(progressTimer);
    if (resourcesMayExist) {
      try {
        // Cleanup deliberately ignores the aborted work signal and cannot select
        // the developer's project because -p and the generated env stay explicit.
        const cleanup = await command('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], {
          env, operation: 'Remove isolated handoff project', timeoutMs: 120_000,
        });
        cleanupFailed = cleanup.code !== 0;
      } catch (_error) { cleanupFailed = true; }
    }
    try { await fs.rm(temporary, { recursive: true, force: true }); }
    catch (_error) { cleanupFailed = true; }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  if (cleanupFailed) {
    console.error(JSON.stringify({ result: label + ' failed', stage: 'cleanup',
      error: 'Inspect the isolated verification project in Docker.', project }));
    process.exitCode = 1;
  } else if (failure) {
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...result, cleanup_completed: true }, null, 2));
}

if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ result: 'Isolated frontend checks failed', stage: 'configuration',
    error: 'Check the local verification arguments and environment.' }));
  process.exitCode = 1;
});

module.exports = { frontendOrigin, publicSummary, cameraProgress };
