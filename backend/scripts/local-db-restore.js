// Restore only into a newly created, explicitly namespaced local database.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

function dockerArguments(container, command) {
  return container
    ? ['exec', '-i', container, ...command]
    : ['compose', 'exec', '-T', 'postgres', ...command];
}

async function runDocker(args, { repoRoot, spawnImpl, signal, input, operation, allowEarlyInputClose = false }) {
  let child;
  try {
    signal?.throwIfAborted();
    child = spawnImpl('docker', args, {
      cwd: repoRoot,
      signal,
      // Archive contents and archive-derived subprocess diagnostics stay private.
      stdio: [input ? 'pipe' : 'ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    input?.destroy();
    throw new Error(`${operation} could not start (${error.code || 'process error'}).`, { cause: error });
  }
  const closed = new Promise(resolve => child.once('close', resolve));
  const completed = new Promise((resolve, reject) => {
    child.once('error', error => {
      reject(new Error(`${operation} could not start (${error.code || 'process error'}).`, { cause: error }));
    });
    child.once('close', (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`${operation} failed (${killedBy || `exit ${code}`}).`));
    });
  });
  const pending = [completed];
  if (input) {
    pending.push(pipeline(input, child.stdin, { signal }).catch(error => {
      // --list needs only the archive TOC. It can exit successfully before a
      // large input finishes streaming; the process exit status still must be 0.
      if (allowEarlyInputClose && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) return;
      throw error;
    }));
  }
  try {
    await Promise.all(pending);
  } catch (error) {
    child.kill('SIGTERM');
    input?.destroy();
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
    forceKill.unref();
    try {
      await Promise.allSettled([...pending, closed]);
    } finally {
      clearTimeout(forceKill);
    }
    throw error;
  }
}

async function restoreDatabase({
  repoRoot = path.resolve(__dirname, '../..'),
  inputPath,
  container,
  database = `focuslens_restore_${Date.now()}_${randomUUID().slice(0, 8)}`,
  spawnImpl = spawn,
  signal,
} = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('An input archive is required (--input FILE).');
  if (typeof database !== 'string' || !/^focuslens_restore_[a-z0-9_]+$/.test(database) || database.length > 63) {
    throw new Error('Restore database must match focuslens_restore_[a-z0-9_]+ and contain at most 63 characters.');
  }
  if (container && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) {
    throw new Error('Container must be a Docker container name or ID.');
  }
  const file = path.resolve(repoRoot, inputPath);
  const stats = await fsp.stat(file);
  if (!stats.isFile() || stats.size === 0) throw new Error('Input must be a nonempty regular archive file.');
  const options = { repoRoot, spawnImpl, signal };
  let creationAttempted = false;
  try {
    await runDocker(dockerArguments(container, ['pg_restore', '--list']), {
      ...options,
      input: fs.createReadStream(file),
      operation: 'Backup archive validation',
      allowEarlyInputClose: true,
    });
    // createdb refuses an existing database atomically; never use --clean or --create.
    // The restricted name also prevents targeting the application's focuslens DB.
    signal?.throwIfAborted();
    creationAttempted = true;
    await runDocker(dockerArguments(container, [
      'createdb', '-U', 'focuslens', '--maintenance-db=postgres', database,
    ]), { ...options, operation: 'Restore database creation' });
    await runDocker(dockerArguments(container, [
      'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges',
      '-U', 'focuslens', '-d', database,
    ]), {
      ...options,
      input: fs.createReadStream(file),
      operation: 'PostgreSQL restore',
    });
    return { path: file, database, bytes: stats.size, archiveVerified: true, restored: true };
  } catch (error) {
    const reason = signal?.aborted ? 'operation cancelled' : error.message.replace(/\.$/, '');
    const retained = creationAttempted ? ' Any created restore database was kept for inspection.' : '';
    throw new Error(`Restore to '${database}' failed: ${reason}.${retained}`, { cause: error });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--input', '--container', '--database'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      const key = arg === '--input' ? 'inputPath' : arg.slice(2);
      if (options[key]) throw new Error(`${arg} may only be supplied once.`);
      options[key] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.inputPath) throw new Error('An input archive is required (--input FILE).');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node backend/scripts/local-db-restore.js --input FILE [--container NAME] [--database NAME]');
    console.log('Default: Compose postgres service; a new focuslens_restore_* database. Existing databases are never replaced.');
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    console.log(JSON.stringify(await restoreDatabase({ ...options, signal: controller.signal }), null, 2));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { restoreDatabase, parseArguments };
