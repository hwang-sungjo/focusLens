const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { restoreDatabase, parseArguments } = require('../local-db-restore');

const ARCHIVE = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128 * 1024, 71)]);
const CHECKSUM = createHash('sha256').update(ARCHIVE).digest('hex');
const CONSUME = `
  const hash = require('node:crypto').createHash('sha256');
  process.stdin.on('data', chunk => hash.update(chunk));
  process.stdin.on('end', () => { if (hash.digest('hex') !== '${CHECKSUM}') process.exitCode = 9; });
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-local-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'backup.dump');
  await fs.writeFile(inputPath, ARCHIVE);
  return { root, inputPath };
}

function fakeDocker({ validate = CONSUME, create = '', restore = CONSUME, afterSpawn } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const source = args.includes('createdb') ? create : args.includes('--list') ? validate : restore;
    const child = spawn(process.execPath, ['-e', source], options);
    afterSpawn?.(child, calls.length);
    return child;
  };
  return { calls, spawnImpl };
}

test('Compose restore validates the archive before creating and populating a unique database', async t => {
  const { root, inputPath } = await fixture(t);
  const docker = fakeDocker();
  const result = await restoreDatabase({ repoRoot: root, inputPath, ...docker });
  assert.match(result.database, /^focuslens_restore_[a-z0-9_]+$/);
  assert.ok(result.database.length <= 63);
  assert.deepEqual(result, { path: inputPath, database: result.database, bytes: ARCHIVE.length, archiveVerified: true, restored: true });
  assert.deepEqual(docker.calls.map(call => call.args), [
    ['compose', 'exec', '-T', 'postgres', 'pg_restore', '--list'],
    ['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'focuslens', '--maintenance-db=postgres', result.database],
    ['compose', 'exec', '-T', 'postgres', 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'focuslens', '-d', result.database],
  ]);
  assert.equal(docker.calls.every(call => call.command === 'docker' && call.options.cwd === root), true);
  assert.equal(docker.calls.every(call => call.options.stdio[1] === 'ignore' && call.options.stdio[2] === 'ignore'), true);
  assert.deepEqual(await fs.readFile(inputPath), ARCHIVE);
  const next = await restoreDatabase({ repoRoot: root, inputPath, ...fakeDocker() });
  assert.notEqual(next.database, result.database);
});

test('a fixed container and explicit safe database name are supported', async t => {
  const { root, inputPath } = await fixture(t);
  const docker = fakeDocker();
  const result = await restoreDatabase({ repoRoot: root, inputPath, container: 'focuslens_postgres', database: 'focuslens_restore_test_1', ...docker });
  assert.equal(result.database, 'focuslens_restore_test_1');
  assert.equal(docker.calls.every(call => call.args.slice(0, 3).join(' ') === 'exec -i focuslens_postgres'), true);
});

test('archive listing may finish before consuming a large input when its exit status is successful', async t => {
  const { root, inputPath } = await fixture(t);
  const large = Buffer.alloc(8 * 1024 * 1024, 71);
  await fs.writeFile(inputPath, large);
  const docker = fakeDocker({
    validate: "process.stdin.once('data', () => process.exit(0));",
    restore: 'process.stdin.resume();',
  });
  const result = await restoreDatabase({ repoRoot: root, inputPath, ...docker });
  assert.equal(result.bytes, large.length);
  assert.equal(docker.calls.length, 3);
});

test('application, maintenance, malformed, and truncated database names are rejected before spawning', async t => {
  const { root, inputPath } = await fixture(t);
  for (const database of ['focuslens', 'postgres', 'focuslens_restore_', 'focuslens_restore_UPPER', 'focuslens_restore_x;DROP', `focuslens_restore_${'x'.repeat(46)}`]) {
    const docker = fakeDocker();
    await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, database, ...docker }), /Restore database must match/);
    assert.equal(docker.calls.length, 0);
  }
});

test('missing, empty, and directory inputs fail before any database command', async t => {
  const { root } = await fixture(t);
  const empty = path.join(root, 'empty.dump');
  await fs.writeFile(empty, '');
  for (const [inputPath, error] of [
    [undefined, /input archive is required/],
    [path.join(root, 'missing.dump'), { code: 'ENOENT' }],
    [root, /nonempty regular archive file/],
    [empty, /nonempty regular archive file/],
  ]) {
    const docker = fakeDocker();
    await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, ...docker }), error);
    assert.equal(docker.calls.length, 0);
  }
});

test('an invalid archive does not create a database and an existing database is never restored into', async t => {
  const { root, inputPath } = await fixture(t);
  const invalid = fakeDocker({ validate: "process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = 7; });" });
  await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, ...invalid }), /Backup archive validation failed/);
  assert.equal(invalid.calls.length, 1);
  const existing = fakeDocker({ create: 'process.exitCode = 1;' });
  await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, database: 'focuslens_restore_existing', ...existing }), /focuslens_restore_existing.*Restore database creation failed/);
  assert.equal(existing.calls.length, 2);
  assert.equal(existing.calls.some(call => call.args.includes('-d')), false);
});

test('a failed restore names and retains its database without revealing archive diagnostics', async t => {
  const { root, inputPath } = await fixture(t);
  const docker = fakeDocker({ restore: "process.stdin.resume(); process.stderr.write('private-archive-content'); process.stdin.on('end', () => { process.exitCode = 8; });" });
  await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, database: 'focuslens_restore_failed', ...docker }), error => {
    assert.match(error.message, /focuslens_restore_failed/);
    assert.match(error.message, /PostgreSQL restore failed/);
    assert.match(error.message, /kept for inspection/);
    assert.doesNotMatch(error.message, /private-archive-content/);
    return true;
  });
  assert.equal(docker.calls.length, 3);
  assert.equal(docker.calls.some(call => call.args.some(arg => ['dropdb', '--clean', '--create'].includes(arg))), false);
  assert.deepEqual(await fs.readFile(inputPath), ARCHIVE);
});

test('an unavailable Docker command reports failure without any database creation', async t => {
  const { root, inputPath } = await fixture(t);
  let calls = 0;
  const spawnImpl = (command, args, options) => {
    calls += 1;
    return spawn(path.join(root, 'missing-docker'), args, options);
  };
  await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, spawnImpl }), /could not start \(ENOENT\)/);
  assert.equal(calls, 1);
});

test('cancelling a restore stops its process and retains the new database for inspection', { timeout: 5000 }, async t => {
  const { root, inputPath } = await fixture(t);
  const controller = new AbortController();
  const docker = fakeDocker({
    restore: "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);",
    afterSpawn: (child, number) => {
      if (number === 3) child.once('spawn', () => setTimeout(() => controller.abort(), 100));
    },
  });
  await assert.rejects(restoreDatabase({ repoRoot: root, inputPath, database: 'focuslens_restore_cancelled', signal: controller.signal, ...docker }), error => {
    assert.match(error.message, /focuslens_restore_cancelled.*operation cancelled/);
    assert.match(error.message, /kept for inspection/);
    return true;
  });
  assert.equal(docker.calls.length, 3);
});

test('CLI requires an archive and rejects unknown or incomplete options', () => {
  assert.deepEqual(parseArguments(['--input', '/tmp/backup.dump', '--container', 'legacy', '--database', 'focuslens_restore_check']), {
    inputPath: '/tmp/backup.dump', container: 'legacy', database: 'focuslens_restore_check',
  });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.throws(() => parseArguments([]), /input archive is required/);
  assert.throws(() => parseArguments(['--input']), /requires a value/);
  assert.throws(() => parseArguments(['--input', '--container', 'legacy']), /requires a value/);
  assert.throws(() => parseArguments(['--input', 'one', '--input', 'two']), /only be supplied once/);
  assert.throws(() => parseArguments(['--clean']), /Unknown option/);
});
