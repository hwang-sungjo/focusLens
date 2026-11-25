const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { backupDatabase, parseArguments } = require('../local-db-backup');

const ARCHIVE = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128 * 1024, 71)]);
const CHECKSUM = createHash('sha256').update(ARCHIVE).digest('hex');
const DUMP = "process.stdout.write(Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128 * 1024, 71)]));";
const RESTORE = `
  const hash = require('node:crypto').createHash('sha256');
  process.stdin.on('data', chunk => hash.update(chunk));
  process.stdin.on('end', () => { if (hash.digest('hex') !== '${CHECKSUM}') process.exitCode = 9; });
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-local-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fakeDocker({ dump = DUMP, restore = RESTORE, beforeSpawn } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    beforeSpawn?.(calls.length);
    const source = args.includes('pg_dump') ? dump : restore;
    return spawn(process.execPath, ['-e', source], options);
  };
  return { calls, spawnImpl };
}

test('a streamed Compose backup is validated, checksummed, and private', async t => {
  const root = await fixture(t);
  const docker = fakeDocker();
  const result = await backupDatabase({ repoRoot: root, ...docker });
  assert.equal(path.dirname(result.path), path.join(root, 'backups'));
  assert.match(path.basename(result.path), /^focuslens-.*\.dump$/);
  assert.deepEqual(await fs.readFile(result.path), ARCHIVE);
  assert.equal(result.bytes, ARCHIVE.length);
  assert.equal(result.sha256, CHECKSUM);
  assert.equal(result.archiveVerified, true);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
  assert.deepEqual(docker.calls.map(call => call.args), [
    ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'focuslens', '-d', 'focuslens', '--format=custom', '--no-owner', '--no-privileges'],
    ['compose', 'exec', '-T', 'postgres', 'pg_restore', '--list'],
  ]);
  assert.equal(docker.calls.every(call => call.command === 'docker' && call.options.cwd === root), true);
  assert.deepEqual(await fs.readdir(path.dirname(result.path)), [path.basename(result.path)]);
});

test('a fixed container and backup directory override are supported', async t => {
  const root = await fixture(t);
  const docker = fakeDocker();
  const result = await backupDatabase({ repoRoot: root, backupDir: 'private-backups', container: 'focuslens_postgres', ...docker });
  assert.equal(path.dirname(result.path), path.join(root, 'private-backups'));
  assert.deepEqual(docker.calls.map(call => call.args.slice(0, 3)), [
    ['exec', '-i', 'focuslens_postgres'],
    ['exec', '-i', 'focuslens_postgres'],
  ]);
});

test('listing a large archive may close input early while still validating successfully', async t => {
  const root = await fixture(t);
  const docker = fakeDocker({
    dump: "process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 71));",
    restore: "process.stdin.once('data', () => process.exit(0));",
  });
  const result = await backupDatabase({ repoRoot: root, ...docker });
  const archive = await fs.readFile(result.path);
  assert.equal(archive.length, 8 * 1024 * 1024);
  assert.equal(result.sha256, createHash('sha256').update(archive).digest('hex'));
  assert.equal(result.archiveVerified, true);
});

test('an existing destination is preserved without invoking Docker', async t => {
  const root = await fixture(t);
  const outputPath = path.join(root, 'keep.dump');
  await fs.writeFile(outputPath, 'existing backup');
  const docker = fakeDocker();
  await assert.rejects(backupDatabase({ repoRoot: root, outputPath, ...docker }), /Backup already exists/);
  assert.equal(docker.calls.length, 0);
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'existing backup');
  assert.deepEqual(await fs.readdir(root), ['keep.dump']);
});

test('a failed dump or invalid archive leaves no completed or partial backup', async t => {
  const root = await fixture(t);
  for (const [name, overrides, message] of [
    ['dump-failed', { dump: "process.stdout.write('partial archive'); process.exitCode = 7;" }, /PostgreSQL backup failed/],
    ['restore-failed', { restore: "process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = 8; });" }, /Backup archive validation failed/],
    ['empty', { dump: '' }, /empty backup/],
  ]) {
    const directory = path.join(root, name);
    await assert.rejects(backupDatabase({ repoRoot: root, backupDir: directory, ...fakeDocker(overrides) }), message);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('failure to start Docker cleans up only its own partial file', async t => {
  const root = await fixture(t);
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(backupDir);
  await fs.writeFile(path.join(backupDir, 'other.partial'), 'keep');
  const spawnImpl = (command, args, options) => spawn(path.join(root, 'missing-docker'), args, options);
  await assert.rejects(backupDatabase({ repoRoot: root, spawnImpl }), /could not start \(ENOENT\)/);
  assert.deepEqual(await fs.readdir(backupDir), ['other.partial']);
  assert.equal(await fs.readFile(path.join(backupDir, 'other.partial'), 'utf8'), 'keep');
});

test('a synchronous subprocess error also removes its incomplete archive', async t => {
  const root = await fixture(t);
  const spawnImpl = () => { throw new Error('Unable to spawn'); };
  await assert.rejects(backupDatabase({ repoRoot: root, spawnImpl }), /Unable to spawn/);
  assert.deepEqual(await fs.readdir(path.join(root, 'backups')), []);
});

test('a destination created during verification cannot be overwritten', async t => {
  const root = await fixture(t);
  const outputPath = path.join(root, 'racing.dump');
  const docker = fakeDocker({
    beforeSpawn: number => { if (number === 2) syncFs.writeFileSync(outputPath, 'concurrent backup'); },
  });
  await assert.rejects(backupDatabase({ repoRoot: root, outputPath, ...docker }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'concurrent backup');
  assert.deepEqual(await fs.readdir(root), ['racing.dump']);
});

test('cancelling a running dump removes the incomplete archive', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const controller = new AbortController();
  const spawnImpl = (command, args, options) => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('PGDMP'); setInterval(() => {}, 1000);"], options);
    child.stdout.once('data', () => controller.abort());
    return child;
  };
  await assert.rejects(backupDatabase({ repoRoot: root, spawnImpl, signal: controller.signal }), /Backup cancelled/);
  assert.deepEqual(await fs.readdir(path.join(root, 'backups')), []);
});

test('CLI arguments reject missing, duplicate, and unknown options', () => {
  assert.deepEqual(parseArguments(['--container', 'legacy', '--output', '/tmp/archive.dump']), {
    container: 'legacy', outputPath: '/tmp/archive.dump',
  });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.throws(() => parseArguments(['--output']), /requires a value/);
  assert.throws(() => parseArguments(['--output', '--container', 'legacy']), /requires a value/);
  assert.throws(() => parseArguments(['--container', 'one', '--container', 'two']), /only be supplied once/);
  assert.throws(() => parseArguments(['--drop-database']), /Unknown option/);
});
