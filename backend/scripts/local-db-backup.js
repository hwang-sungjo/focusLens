// Stream a local PostgreSQL backup without replacing an existing archive.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

function dockerArguments(container, command) {
  return container
    ? ['exec', '-i', container, ...command]
    : ['compose', 'exec', '-T', 'postgres', ...command];
}

async function runDocker(args, { repoRoot, spawnImpl, signal, input, output, operation, allowEarlyInputClose = false }) {
  let child;
  try {
    signal?.throwIfAborted();
    child = spawnImpl('docker', args, {
      cwd: repoRoot,
      signal,
      // Archive bytes and subprocess diagnostics must never reach the terminal.
      stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'ignore'],
    });
  } catch (error) {
    input?.destroy();
    output?.destroy();
    throw error;
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
      // Listing reads only the TOC and may close stdin before a large archive
      // finishes streaming. The subprocess must still report a successful exit.
      if (allowEarlyInputClose && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) return;
      throw error;
    }));
  }
  if (output) pending.push(pipeline(child.stdout, output, { signal }));
  try {
    await Promise.all(pending);
  } catch (error) {
    child.kill('SIGTERM');
    input?.destroy();
    output?.destroy();
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

async function backupDatabase({
  repoRoot = path.resolve(__dirname, '../..'),
  outputPath,
  container,
  backupDir = process.env.LOCAL_BACKUP_DIR,
  spawnImpl = spawn,
  signal,
} = {}) {
  if (container && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) {
    throw new Error('Container must be a Docker container name or ID.');
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = outputPath
    ? path.resolve(repoRoot, outputPath)
    : path.resolve(repoRoot, backupDir || 'backups', `focuslens-${timestamp}-${randomUUID()}.dump`);
  try {
    await fsp.lstat(file);
    throw new Error(`Backup already exists: ${file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  signal?.throwIfAborted();
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.partial`);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    try {
      const output = handle.createWriteStream({ autoClose: true, flush: true });
      await runDocker(dockerArguments(container, [
        'pg_dump', '-U', 'focuslens', '-d', 'focuslens',
        '--format=custom', '--no-owner', '--no-privileges',
      ]), { repoRoot, spawnImpl, signal, output, operation: 'PostgreSQL backup' });
    } finally {
      await handle.close();
    }
    const { size } = await fsp.stat(temporary);
    if (size === 0) throw new Error('PostgreSQL returned an empty backup.');
    await runDocker(dockerArguments(container, ['pg_restore', '--list']), {
      repoRoot,
      spawnImpl,
      signal,
      input: fs.createReadStream(temporary),
      operation: 'Backup archive validation',
      allowEarlyInputClose: true,
    });
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(temporary)) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    signal?.throwIfAborted();
    // A hard link publishes the complete archive atomically and refuses to overwrite
    // even if another backup creates the destination after the initial check.
    await fsp.link(temporary, file);
    return { path: file, bytes: size, sha256: hash.digest('hex'), archiveVerified: true };
  } catch (error) {
    if (signal?.aborted) throw new Error('Backup cancelled.', { cause: error });
    throw error;
  } finally {
    await fsp.unlink(temporary);
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--container' || arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      const key = arg === '--container' ? 'container' : 'outputPath';
      if (options[key]) throw new Error(`${arg} may only be supplied once.`);
      options[key] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node backend/scripts/local-db-backup.js [--container NAME] [--output FILE]');
    console.log('Default: Compose postgres service; backups/ or LOCAL_BACKUP_DIR. Existing files are preserved.');
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = await backupDatabase({ ...options, signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
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

module.exports = { backupDatabase, parseArguments };
