// Redis data-loss maintenance: stop the API before replacing authentication state.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const STOPPED_STATES = new Set(['created', 'exited', 'dead']);

function jwtAssignment(content) {
  const entries = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = body.match(/^[ \t]*(?:export[ \t]+)?JWT_SECRET[ \t]*(=|:)[ \t]*/);
    if (match) entries.push({ offset, body, match });
    offset += line.length + 1;
  }
  if (entries.length !== 1) throw new Error('Environment must contain exactly one JWT_SECRET assignment.');
  const { offset: lineOffset, body, match } = entries[0];
  if (match[1] !== '=') throw new Error('JWT_SECRET must use a single-line KEY=value assignment.');
  const start = lineOffset + match[0].length;
  const raw = body.slice(match[0].length);
  let length;
  let previous;
  if (['"', "'", '`'].includes(raw[0])) {
    const quote = raw[0];
    let closing = 1;
    while (closing < raw.length) {
      if (raw[closing] === '\\') closing += 2;
      else if (raw[closing] === quote) break;
      else closing += 1;
    }
    if (closing >= raw.length || !/^[ \t]*(?:#.*)?$/.test(raw.slice(closing + 1))) {
      throw new Error('JWT_SECRET must use one complete single-line value.');
    }
    previous = raw.slice(1, closing);
    length = closing + 1;
  } else {
    const hash = raw.indexOf('#');
    previous = (hash < 0 ? raw : raw.slice(0, hash)).trimEnd();
    length = previous.length;
  }
  if (!previous) throw new Error('JWT_SECRET must be nonempty.');
  return { start, length, previous };
}

async function readEnvironment(file) {
  // Opening with O_NOFOLLOW also protects the lstat/open boundary from symlink swaps.
  const info = await fsp.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Environment must be an existing regular file without a symlink.');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== info.dev || stat.ino !== info.ino) {
      throw new Error('Environment changed while it was being opened.');
    }
    const bytes = await handle.readFile();
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Environment must contain valid UTF-8 text.');
    const assignment = jwtAssignment(content);
    return { bytes, content, stat, assignment };
  } finally {
    await handle.close();
  }
}

async function assertUnchanged(file, expected) {
  const actual = await readEnvironment(file);
  const keys = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
  if (!keys.every(key => actual.stat[key] === expected.stat[key]) || !actual.bytes.equals(expected.bytes)) {
    throw new Error('Environment changed during authentication recovery.');
  }
  return actual;
}

async function runDocker(args, { repoRoot, env, spawnImpl, signal, operation, timeoutMs = 200_000 }) {
  if (signal?.aborted) throw new Error('Authentication recovery was cancelled before starting Docker.');
  let child;
  try {
    child = spawnImpl('docker', args, {
      cwd: repoRoot, env, signal,
      // Docker and psql diagnostics can contain credentials. Never inherit them.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_error) {
    throw new Error(`${operation} could not start.`);
  }
  let output = '';
  let outputTooLarge = false;
  child.stdout.on('data', chunk => {
    if (outputTooLarge) return;
    if (output.length + chunk.length > 2 * 1024 * 1024) {
      outputTooLarge = true;
      child.kill('SIGTERM');
    } else output += chunk.toString('utf8');
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${operation} could not finish.`)));
    child.once('close', (code) => {
      if (code === 0 && !outputTooLarge) resolve();
      else reject(new Error(`${operation} failed.`));
    });
  });
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${operation} timed out.`)), timeoutMs);
    timeout.unref?.();
  });
  try {
    await Promise.race([completed, deadline]);
    return output.trim();
  } catch (error) {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    kill.unref?.();
    try { await Promise.allSettled([completed, closed]); } finally { clearTimeout(kill); }
    throw error;
  } finally { clearTimeout(timeout); }
}

function stoppedContainers(output) {
  if (!output) return true;
  let containers;
  try {
    const parsed = JSON.parse(output);
    containers = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_error) {
    try { containers = output.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (_parseError) { throw new Error('Backend stopped state could not be read.'); }
  }
  if (!containers.every(container => container && STOPPED_STATES.has(String(container.State).toLowerCase()))) {
    throw new Error('Backend is still running or its stopped state is unknown.');
  }
  return true;
}

async function unlinkOwned(file, expected) {
  try {
    const actual = await fsp.lstat(file);
    if (actual.dev === expected.dev && actual.ino === expected.ino) await fsp.unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function recoverLocalAuth({
  repoRoot = path.resolve(__dirname, '../..'),
  envFile = process.env.LOCAL_ENV_FILE,
  spawnImpl = spawn,
  signal,
  onStage = () => {},
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const file = path.resolve(repoRoot, envFile || 'backend/.env');
  let original;
  try { original = await readEnvironment(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('An existing local environment file is required. Run local:up before authentication recovery.');
    if (['ELOOP', 'EISDIR'].includes(error.code)) throw new Error('Environment must be an existing regular file without a symlink.');
    // Validation messages contain key names only, never file contents.
    if (!error.code) throw error;
    throw new Error('Local environment file could not be read.');
  }
  if (signal?.aborted) throw new Error('Authentication recovery was cancelled before it started.');
  const lockFile = path.join(repoRoot, '.auth-recovery.lock');
  let lock;
  try { lock = await fsp.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another authentication recovery holds .auth-recovery.lock.');
    throw new Error('Authentication recovery lock could not be created.');
  }
  const lockStat = await lock.stat();
  const env = { ...process.env, LOCAL_ENV_FILE: file };
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const compose = ['compose', '--project-directory', repoRoot, '-f', path.join(repoRoot, 'docker-compose.yml')];
  const execute = (args, operation, extra = {}) => runDocker([...compose, ...args], {
    repoRoot, env, spawnImpl, signal, operation, ...extra,
  });
  const ensureStopped = async (extra = {}) => {
    await execute(['stop', '--timeout', '15', 'backend'], 'Backend stop', { timeoutMs: 30_000, ...extra });
    stoppedContainers(await execute(['ps', '--all', '--format', 'json', 'backend'],
      'Backend state check', { timeoutMs: 30_000, ...extra }));
  };
  let stage = 'validate_environment';
  let stopAttempted = false;
  let temporary;
  let temporaryStat;
  let lockReleased = false;
  const progress = value => { stage = value; onStage(value); };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    await lock.sync();
    await assertUnchanged(file, original);
    progress('stop_backend');
    stopAttempted = true;
    await ensureStopped();
    signal?.throwIfAborted();

    progress('rotate_jwt_secret');
    await assertUnchanged(file, original);
    let secret;
    do { secret = randomBytes(32).toString('hex'); } while (secret === original.assignment.previous);
    const { start, length } = original.assignment;
    const replacement = Buffer.from(original.content.slice(0, start) + secret + original.content.slice(start + length), 'utf8');
    temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.auth-recovery.tmp`);
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      temporaryStat = await handle.stat();
      await handle.writeFile(replacement);
      await handle.sync();
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    await assertUnchanged(file, original);
    await fsp.rename(temporary, file);
    temporary = undefined;
    const rotated = await readEnvironment(file);
    if (!rotated.bytes.equals(replacement) || (rotated.stat.mode & 0o777) !== 0o600) {
      throw new Error('Rotated local environment could not be confirmed.');
    }

    progress('prepare_postgres_and_redis');
    await execute(['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis'], 'Dependency readiness');
    await assertUnchanged(file, rotated);

    progress('revoke_refresh_tokens');
    const count = await execute(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', 'focuslens', '-d', 'focuslens', '-Atc',
      'WITH revoked AS (UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL RETURNING 1) SELECT count(*) FROM revoked;',
    ], 'Refresh token revocation', { timeoutMs: 30_000 });
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error('Refresh token revocation count was invalid.');
    signal?.throwIfAborted();
    await assertUnchanged(file, rotated);

    progress('restart_backend');
    await execute(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'backend'], 'Backend restart');
    signal?.throwIfAborted();
    await assertUnchanged(file, rotated);
    progress('complete');
    await lock.close();
    await unlinkOwned(lockFile, lockStat);
    lockReleased = true;
    return {
      result: 'Local authentication recovery completed', env_file: file,
      jwt_secret_rotated: true, refresh_tokens_revoked: Number(count),
      backend_restarted: true, relogin_required: true,
    };
  } catch (_error) {
    let confirmedStopped = false;
    if (stopAttempted) {
      try { await ensureStopped({ signal: undefined }); confirmedStopped = true; } catch (_stopError) { /* Report uncertainty without exposing Docker diagnostics. */ }
    }
    const state = !stopAttempted ? 'Backend configuration was not applied.'
      : confirmedStopped ? 'Backend is stopped.' : 'Backend stop could not be confirmed; keep the API stopped.';
    throw new Error(`Local authentication recovery failed at ${stage}. ${state} Sign in again after a successful recovery.`);
  } finally {
    if (temporary && temporaryStat) await unlinkOwned(temporary, temporaryStat).catch(() => {});
    if (!lockReleased) {
      await lock.close().catch(() => {});
      await unlinkOwned(lockFile, lockStat).catch(() => {});
    }
  }
}

function parseArguments(argv) {
  if (!argv.length) return { help: false };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  throw new Error('Usage: node backend/scripts/recover-local-auth.js [--help]');
}

async function main() {
  if (parseArguments(process.argv.slice(2)).help) {
    console.log('Usage: node backend/scripts/recover-local-auth.js [--help]');
    console.log('Stops the local API, rotates JWT_SECRET, revokes every Refresh Token, and recreates the API. All users must sign in again.');
    console.log('Requires a previously started local stack and its existing backend/.env or LOCAL_ENV_FILE.');
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = await recoverLocalAuth({
      signal: controller.signal,
      onStage: stage => console.log(JSON.stringify({ stage })),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { recoverLocalAuth, parseArguments };
