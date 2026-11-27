const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { defaultAiPython } = require('../local-ai-python');

const wrapper = path.resolve(__dirname, '../local-ai.js');

test('an installed project interpreter is preferred over the Python 3.11 PATH fallback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-python-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(defaultAiPython(root), 'python3.11');
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const python = path.join(root, '.local', 'ai-venv', bin, process.platform === 'win32' ? 'python.exe' : 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '', { mode: 0o700 });
  assert.equal(defaultAiPython(root), python);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`the npm wrapper forwards ${signal} and waits for the camera child to close`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-wrapper-'));
    const launcher = path.join(directory, 'python-stub');
    await fs.writeFile(launcher, '#!/usr/bin/env node\n' + [
      "process.on('SIGINT', () => setTimeout(() => process.exit(0), 20));",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));",
      'process.stdout.write(String(process.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n'), { mode: 0o700 });
    const child = spawn(process.execPath, [wrapper, 'measure'], {
      env: { ...process.env, FOCUSLENS_AI_PYTHON: launcher }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cameraPid;
    t.after(async () => {
      child.kill('SIGKILL');
      if (cameraPid) { try { process.kill(cameraPid, 'SIGKILL'); } catch (_) {} }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const [chunk] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    cameraPid = Number(chunk.toString().trim());
    assert.ok(Number.isSafeInteger(cameraPid) && cameraPid > 0);
    const exited = once(child, 'close', { signal: AbortSignal.timeout(5000) });
    child.kill(signal);
    const [code, killedBy] = await exited;
    assert.equal(code, 0);
    assert.equal(killedBy, null);
    assert.throws(() => process.kill(cameraPid, 0), { code: 'ESRCH' });
  });
}

test('an unavailable Python interpreter reports a clear error and exits', async () => {
  const child = spawn(process.execPath, [wrapper, 'status'], {
    env: { ...process.env, FOCUSLENS_AI_PYTHON: '/nonexistent/focuslens-python' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close', { signal: AbortSignal.timeout(5000) });
  assert.equal(code, 1);
  assert.match(stderr, /FOCUSLENS_AI_PYTHON/);
});
