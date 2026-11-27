const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { acquireLauncher } = require('../local-stack-lock');

async function workingCopy(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'focuslens-launcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('only one launcher can own a working copy and release is idempotent', async t => {
  const root = await workingCopy(t);
  const results = await Promise.all([acquireLauncher(root), acquireLauncher(root)]);
  const owners = results.filter(Boolean);
  assert.equal(owners.length, 1);
  const release = owners[0];
  release();
  const next = await acquireLauncher(root);
  assert.equal(typeof next, 'function');
  try {
    release();
    assert.equal(await acquireLauncher(root), null);
  } finally {
    next();
  }
});

test('a killed launcher releases its lock for the next process', { timeout: 10000 }, async t => {
  const root = await workingCopy(t);
  const owner = spawn(process.execPath, ['-e', `
    const { acquireLauncher } = require(process.argv[1]);
    acquireLauncher(process.argv[2]).then(release => {
      process.on('message', () => release());
      process.send(Boolean(release));
    }).catch(() => process.exit(1));
  `, require.resolve('../local-stack-lock'), root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(owner, 'exit');
  try {
    const [acquired] = await Promise.race([
      once(owner, 'message'),
      exited.then(() => { throw new Error('Child launcher exited before acquiring the lock'); }),
    ]);
    assert.equal(acquired, true);
    assert.equal(await acquireLauncher(root), null);
  } finally {
    owner.kill('SIGKILL');
    await exited;
  }
  const release = await acquireLauncher(root);
  assert.equal(typeof release, 'function');
  release();
});
