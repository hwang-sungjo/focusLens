// LBE-5: build, seed and test only a disposable local Compose project.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureLocalEnv } = require('./local-env');

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
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node backend/scripts/verify-handoff-stack.js');
    console.log('Builds a separate local stack, seeds it, checks frontend API contracts, and removes only its own resources.');
    console.log('Optional LOCAL_FRONTEND_ORIGIN defaults to http://localhost:5173. Existing projects are never selected.');
    return;
  }
  assert.equal(args.length, 0, 'Only --help is accepted; this verifier never targets an existing project.');
  const origin = frontendOrigin(process.env.LOCAL_FRONTEND_ORIGIN || 'http://localhost:5173');
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

    const address = await composeRun(['port', 'backend', '3000'], 'Find isolated API port', { timeoutMs: 30_000 });
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'Verification API must bind to an isolated loopback port');
    const verifyEnv = { ...env, LOCAL_VERIFY_URL: `http://${address}` };
    progress('verify_frontend_cookie_privacy_and_group_contracts');
    const checked = await command(process.execPath, [path.join(__dirname, 'verify-frontend-handoff.js')], {
      env: verifyEnv, operation: 'Frontend handoff API checks', signal: controller.signal, timeoutMs: 180_000,
    });
    try { apiSummary = publicSummary(JSON.parse(checked.output || checked.diagnostics)); }
    catch (_error) { throw new Error('Frontend handoff checks did not return a safe JSON summary.'); }
    if (checked.code !== 0) throw new Error('Frontend handoff API checks failed.');
    result = {
      result: 'LBE-5 isolated handoff checks passed', frontend_origin: origin,
      migrations, query_views: views, seed_completed: true,
      api_checks: apiSummary, original_services_untouched: true,
    };
  } catch (error) {
    failure = { result: 'LBE-5 isolated handoff checks failed', stage,
      error: error.message, ...(apiSummary && { api_checks: apiSummary }) };
  } finally {
    clearInterval(heartbeat);
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
    console.error(JSON.stringify({ result: 'LBE-5 isolated handoff checks failed', stage: 'cleanup',
      error: 'Inspect the isolated verification project in Docker.', project }));
    process.exitCode = 1;
  } else if (failure) {
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...result, cleanup_completed: true }, null, 2));
}

if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ result: 'LBE-5 isolated handoff checks failed', stage: 'configuration',
    error: 'Check the local verification arguments and environment.' }));
  process.exitCode = 1;
});

module.exports = { frontendOrigin, publicSummary };
