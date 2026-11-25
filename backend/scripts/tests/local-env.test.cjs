const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureLocalEnv } = require('../local-env');

const TEMPLATE = [
  '# local test template',
  'NODE_ENV=development',
  'PORT=3000',
  'DATABASE_URL="postgresql://test:test@localhost/test"',
  'JWT_SECRET=replace_with_a_local_development_secret',
  'REDIS_URL=redis://localhost:6379',
  'CORS_ORIGIN=http://localhost:5173',
  'ROLLUP_ENABLED=false',
  '',
].join('\n');

async function fixture(t, template = TEMPLATE) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-local-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'backend'));
  await fs.writeFile(path.join(root, 'backend/.env.local.example'), template);
  return root;
}

test('new environment has a random secret, private permissions, and template settings', async t => {
  const root = await fixture(t);
  const result = await ensureLocalEnv({ repoRoot: root });
  const content = await fs.readFile(result.path, 'utf8');
  assert.equal(result.created, true);
  assert.match(content, /^JWT_SECRET=[a-f0-9]{64}$/m);
  assert.equal(content.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=replace_with_a_local_development_secret'), TEMPLATE);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});

test('an existing environment and secret are preserved byte for byte', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'backend/.env');
  const existing = TEMPLATE.replace('replace_with_a_local_development_secret', 'existing-secret');
  await fs.writeFile(file, existing);
  const before = await fs.stat(file);
  assert.deepEqual(await ensureLocalEnv({ repoRoot: root }), { created: false, path: file });
  assert.equal(await fs.readFile(file, 'utf8'), existing);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test('isolated environment override works without creating the default file', async t => {
  const root = await fixture(t);
  const destination = path.join(root, 'isolated/config.env');
  const result = await ensureLocalEnv({ repoRoot: root, envFile: destination });
  assert.equal(result.path, destination);
  assert.equal(result.created, true);
  await assert.rejects(fs.access(path.join(root, 'backend/.env')), { code: 'ENOENT' });
});

test('missing required settings report key names and leave existing files untouched', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'backend/.env');
  const invalid = 'JWT_SECRET=do-not-print-this-secret\nCORS_ORIGIN=""\n';
  await fs.writeFile(file, invalid);
  await assert.rejects(ensureLocalEnv({ repoRoot: root }), error => {
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /CORS_ORIGIN/);
    assert.doesNotMatch(error.message, /do-not-print-this-secret/);
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), invalid);
});

test('concurrent preparation publishes only one complete environment', async t => {
  const root = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureLocalEnv({ repoRoot: root })));
  assert.equal(results.filter(result => result.created).length, 1);
  const content = await fs.readFile(results[0].path, 'utf8');
  assert.match(content, /^JWT_SECRET=[a-f0-9]{64}$/m);
  assert.deepEqual((await fs.readdir(path.join(root, 'backend'))).sort(), ['.env', '.env.local.example']);
});

test('a missing template fails before creating a new environment', async t => {
  const root = await fixture(t);
  await fs.unlink(path.join(root, 'backend/.env.local.example'));
  await assert.rejects(ensureLocalEnv({ repoRoot: root }), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'backend/.env')), { code: 'ENOENT' });
});
