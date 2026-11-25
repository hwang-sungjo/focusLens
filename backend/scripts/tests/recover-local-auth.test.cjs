const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { recoverLocalAuth, parseArguments } = require('../recover-local-auth');

const ORIGINAL = '# 로컬 설정\r\nNODE_ENV=development\r\nexport JWT_SECRET = "old-local-secret"   # preserve this comment\r\nDATABASE_URL="postgresql://local/db"\r\nREDIS_URL=redis://localhost:6379\r\n';
const STOPPED = 'process.stdout.write(JSON.stringify([{State:"exited"}]));';

async function fixture(t, content = ORIGINAL) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'focuslens-auth-recovery-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'backend'));
  const envFile = path.join(root, 'backend/.env');
  await fsp.writeFile(envFile, content, { mode: 0o640 });
  return { root, envFile };
}

function action(args) {
  if (args.includes('stop')) return 'stop';
  if (args.includes('ps')) return 'state';
  if (args.includes('exec')) return 'revoke';
  if (args.includes('up') && args.at(-1) === 'backend') return 'restart';
  if (args.includes('up') && args.at(-1) === 'redis') return 'dependencies';
  throw new Error('Unexpected mock Docker operation');
}

function fakeDocker({ scripts = {}, onCall, afterSpawn } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const kind = action(args);
    const call = { command, args, options, kind };
    calls.push(call);
    onCall?.(call, calls);
    const code = typeof scripts[kind] === 'function'
      ? scripts[kind](calls.filter(item => item.kind === kind).length)
      : scripts[kind] ?? (kind === 'state' ? STOPPED : kind === 'revoke' ? 'process.stdout.write("7\\n");' : '');
    const child = spawn(process.execPath, ['-e', code], options);
    afterSpawn?.(child, call, calls);
    return child;
  };
  return { spawnImpl, calls };
}

async function assertClean(root, envFile) {
  await assert.rejects(fsp.lstat(path.join(root, '.auth-recovery.lock')), { code: 'ENOENT' });
  const files = await fsp.readdir(path.dirname(envFile));
  assert.equal(files.some(file => file.endsWith('.auth-recovery.tmp')), false);
}

test('recovery stops and confirms the API before atomically rotating its secret, revoking refresh tokens, and restarting', async t => {
  const { root, envFile } = await fixture(t);
  const stages = [];
  const observations = [];
  const docker = fakeDocker({ onCall: call => observations.push({
    kind: call.kind, content: fs.readFileSync(envFile, 'utf8'), mode: fs.statSync(envFile).mode & 0o777,
  }) });
  const result = await recoverLocalAuth({ repoRoot: root, ...docker, onStage: stage => stages.push(stage) });
  assert.deepEqual(docker.calls.map(call => call.kind), ['stop', 'state', 'dependencies', 'revoke', 'restart']);
  assert.deepEqual(stages, ['stop_backend', 'rotate_jwt_secret', 'prepare_postgres_and_redis', 'revoke_refresh_tokens', 'restart_backend', 'complete']);
  assert.equal(observations[0].content, ORIGINAL);
  assert.equal(observations[1].content, ORIGINAL);
  const content = await fsp.readFile(envFile, 'utf8');
  const secret = content.match(/JWT_SECRET = ([a-f0-9]{64})/)[1];
  assert.notEqual(secret, 'old-local-secret');
  assert.equal(content.replace(secret, '"old-local-secret"'), ORIGINAL, 'all other configuration bytes and comments stay identical');
  assert.equal(observations.slice(2).every(item => item.content === content && item.mode === 0o600), true);
  assert.deepEqual(result, {
    result: 'Local authentication recovery completed', env_file: envFile,
    jwt_secret_rotated: true, refresh_tokens_revoked: 7, backend_restarted: true, relogin_required: true,
  });
  const prefix = ['compose', '--project-directory', root, '-f', path.join(root, 'docker-compose.yml')];
  assert.equal(docker.calls.every(call => call.command === 'docker' && call.options.cwd === root
    && JSON.stringify(call.args.slice(0, prefix.length)) === JSON.stringify(prefix)), true);
  assert.equal(docker.calls.every(call => call.options.stdio.join(',') === 'ignore,pipe,ignore'), true);
  assert.ok(docker.calls[0].args.includes('--timeout') && docker.calls[0].args.includes('15'));
  assert.ok(docker.calls.at(-1).args.includes('--no-deps') && docker.calls.at(-1).args.includes('--force-recreate'));
  assert.equal(docker.calls.some(call => call.args.includes('--build') || call.args.includes('down')), false);
  const revoke = docker.calls.find(call => call.kind === 'revoke');
  assert.ok(revoke.args.includes('ON_ERROR_STOP=1'));
  assert.match(revoke.args.at(-1), /UPDATE refresh_tokens SET revoked_at=clock_timestamp\(\) WHERE revoked_at IS NULL/);
  await assertClean(root, envFile);
});

test('a custom environment path is absolute in Compose and inherited Compose file selection is ignored', async t => {
  const { root } = await fixture(t);
  const envFile = path.join(root, 'custom.env');
  await fsp.writeFile(envFile, 'JWT_SECRET=alternate\n# custom\n');
  const previous = Object.fromEntries(['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES'].map(key => [key, process.env[key]]));
  process.env.COMPOSE_FILE = '/wrong/compose.yml';
  process.env.COMPOSE_PROJECT_NAME = 'focuslens-chosen-local';
  process.env.COMPOSE_PROFILES = 'unrelated';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const docker = fakeDocker();
  await recoverLocalAuth({ repoRoot: root, envFile: 'custom.env', ...docker });
  assert.equal(docker.calls.every(call => call.options.env.LOCAL_ENV_FILE === envFile
    && call.options.env.COMPOSE_PROJECT_NAME === 'focuslens-chosen-local'
    && !('COMPOSE_FILE' in call.options.env) && !('COMPOSE_PROFILES' in call.options.env)), true);
  assert.equal(await fsp.readFile(path.join(root, 'backend/.env'), 'utf8'), ORIGINAL);
});

test('missing, symlink, directory, empty, duplicate, and multiline JWT environments are rejected before Docker', async t => {
  const { root, envFile } = await fixture(t);
  const target = path.join(root, 'real.env');
  await fsp.writeFile(target, 'JWT_SECRET=preserved\n');
  const symlink = path.join(root, 'linked.env');
  await fsp.symlink(target, symlink);
  const cases = [
    [path.join(root, 'missing.env'), /existing local environment file is required/],
    [symlink, /regular file without a symlink/],
    [root, /regular file without a symlink/],
  ];
  for (const [file, expected] of cases) {
    const docker = fakeDocker();
    await assert.rejects(recoverLocalAuth({ repoRoot: root, envFile: file, ...docker }), expected);
    assert.equal(docker.calls.length, 0);
  }
  for (const content of ['PORT=3000\n', 'JWT_SECRET=\n', 'JWT_SECRET=""\n', 'JWT_SECRET=one\nexport JWT_SECRET=two\n',
    'JWT_SECRET=one\nJWT_SECRET : two\n', 'JWT_SECRET="multi\nline"\n']) {
    await fsp.writeFile(envFile, content);
    const docker = fakeDocker();
    await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /JWT_SECRET/);
    assert.equal(docker.calls.length, 0);
    assert.equal(await fsp.readFile(envFile, 'utf8'), content);
  }
  await assert.rejects(fsp.lstat(path.join(root, '.auth-recovery.lock')), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(target, 'utf8'), 'JWT_SECRET=preserved\n');
});

test('invalid UTF-8 is rejected rather than rewriting unrelated environment bytes', async t => {
  const content = Buffer.concat([Buffer.from('JWT_SECRET=old\n'), Buffer.from([0xff, 0x00])]);
  const { root, envFile } = await fixture(t, content);
  const docker = fakeDocker();
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /valid UTF-8/);
  assert.equal(docker.calls.length, 0);
  assert.deepEqual(await fsp.readFile(envFile), content);
});

test('an existing exclusive recovery lock is preserved and prevents all Docker operations', async t => {
  const { root, envFile } = await fixture(t);
  const lock = path.join(root, '.auth-recovery.lock');
  await fsp.writeFile(lock, 'another operation');
  const docker = fakeDocker();
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /Another authentication recovery/);
  assert.equal(docker.calls.length, 0);
  assert.equal(await fsp.readFile(lock, 'utf8'), 'another operation');
  assert.equal(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
});

test('a replacement lock belonging to another operation is not deleted', async t => {
  const { root, envFile } = await fixture(t);
  const lock = path.join(root, '.auth-recovery.lock');
  const held = path.join(root, 'old-lock');
  const docker = fakeDocker({ onCall: call => {
    if (call.kind === 'restart') {
      fs.renameSync(lock, held);
      fs.writeFileSync(lock, 'replacement lock');
    }
  } });
  await recoverLocalAuth({ repoRoot: root, ...docker });
  assert.equal(await fsp.readFile(lock, 'utf8'), 'replacement lock');
  assert.match(await fsp.readFile(held, 'utf8'), /started_at/);
  assert.notEqual(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
});

test('a failed stop or non-stopped state never rotates secrets or starts the API', async t => {
  const { root, envFile } = await fixture(t);
  const failed = fakeDocker({ scripts: { stop: number => number === 1 ? 'process.exitCode=8;' : '' } });
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...failed }), /stop_backend.*Backend is stopped/);
  assert.deepEqual(failed.calls.map(call => call.kind), ['stop', 'stop', 'state']);
  assert.equal(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
  await assertClean(root, envFile);
  for (const state of ['running', 'paused', 'restarting', 'unknown']) {
    const docker = fakeDocker({ scripts: { state: `process.stdout.write(JSON.stringify({State:'${state}'}));` } });
    await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /stop_backend.*stop could not be confirmed/);
    assert.deepEqual(docker.calls.map(call => call.kind), ['stop', 'state', 'stop', 'state']);
    assert.equal(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
    await assertClean(root, envFile);
  }
});

test('an absent backend or newline-delimited stopped containers can be recovered', async t => {
  const { root, envFile } = await fixture(t);
  for (const state of ['', JSON.stringify({ State: 'exited' }) + '\n' + JSON.stringify({ State: 'created' })]) {
    const docker = fakeDocker({ scripts: { state: `process.stdout.write(${JSON.stringify(state)});` } });
    await recoverLocalAuth({ repoRoot: root, ...docker });
    await assertClean(root, envFile);
  }
});

test('environment edits before the atomic replacement are preserved and leave the API stopped', async t => {
  const { root, envFile } = await fixture(t);
  const changed = ORIGINAL + 'NEW_SETTING=keep_me\r\n';
  const docker = fakeDocker();
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker, onStage: stage => {
    if (stage === 'rotate_jwt_secret') fs.writeFileSync(envFile, changed);
  } }), /rotate_jwt_secret.*Backend is stopped/);
  assert.equal(await fsp.readFile(envFile, 'utf8'), changed);
  assert.deepEqual(docker.calls.map(call => call.kind), ['stop', 'state', 'stop', 'state']);
  await assertClean(root, envFile);
});

test('an inode replacement with the same bytes is detected before the secret is written', async t => {
  const { root, envFile } = await fixture(t);
  const moved = envFile + '.editor';
  const docker = fakeDocker();
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker, onStage: stage => {
    if (stage === 'rotate_jwt_secret') {
      fs.writeFileSync(moved, ORIGINAL);
      fs.renameSync(moved, envFile);
    }
  } }), /rotate_jwt_secret.*Backend is stopped/);
  assert.equal(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
  assert.equal(docker.calls.some(call => call.kind === 'restart'), false);
  await assertClean(root, envFile);
});

test('an edit after rotation is preserved and prevents restarting with unverified configuration', async t => {
  const { root, envFile } = await fixture(t);
  let changed;
  const docker = fakeDocker({ onCall: call => {
    if (call.kind === 'dependencies') {
      changed = fs.readFileSync(envFile, 'utf8') + 'EDITOR_CHANGE=preserve\r\n';
      fs.writeFileSync(envFile, changed);
    }
  } });
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /prepare_postgres_and_redis.*Backend is stopped/);
  assert.equal(await fsp.readFile(envFile, 'utf8'), changed);
  assert.equal(docker.calls.some(call => call.kind === 'restart' || call.kind === 'revoke'), false);
  await assertClean(root, envFile);
});

test('dependency or revocation failures retain the new secret, stop the API again, and hide diagnostics', async t => {
  const { root, envFile } = await fixture(t);
  for (const kind of ['dependencies', 'revoke']) {
    await fsp.writeFile(envFile, ORIGINAL);
    const docker = fakeDocker({ scripts: { [kind]: 'process.stdout.write("PRIVATE_STDOUT");process.stderr.write("PRIVATE_PASSWORD");process.exitCode=9;' } });
    await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), error => {
      assert.match(error.message, /Backend is stopped.*Sign in again/);
      assert.doesNotMatch(error.message, /PRIVATE_|old-local-secret/);
      return true;
    });
    assert.notEqual(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
    assert.equal(docker.calls.some(call => call.kind === 'restart'), false);
    assert.deepEqual(docker.calls.slice(-2).map(call => call.kind), ['stop', 'state']);
    await assertClean(root, envFile);
  }
});

test('unexpected psql output is never treated as a successful revocation', async t => {
  const { root, envFile } = await fixture(t);
  const docker = fakeDocker({ scripts: { revoke: 'process.stdout.write("private contents instead of count");' } });
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), error => {
    assert.match(error.message, /revoke_refresh_tokens.*Backend is stopped/);
    assert.doesNotMatch(error.message, /private contents/);
    return true;
  });
  assert.equal(docker.calls.some(call => call.kind === 'restart'), false);
  await assertClean(root, envFile);
});

test('a failed backend readiness check stops the partially restarted backend', async t => {
  const { root, envFile } = await fixture(t);
  const docker = fakeDocker({ scripts: { restart: 'process.exitCode=4;' } });
  await assert.rejects(recoverLocalAuth({ repoRoot: root, ...docker }), /restart_backend.*Backend is stopped/);
  assert.deepEqual(docker.calls.map(call => call.kind), ['stop', 'state', 'dependencies', 'revoke', 'restart', 'stop', 'state']);
  await assertClean(root, envFile);
});

test('cancellation during maintenance terminates its child and stops the API without restarting', { timeout: 6000 }, async t => {
  const { root, envFile } = await fixture(t);
  const controller = new AbortController();
  const docker = fakeDocker({
    scripts: { dependencies: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" },
    afterSpawn: (child, call) => {
      if (call.kind === 'dependencies') child.once('spawn', () => setTimeout(() => controller.abort(), 150));
    },
  });
  await assert.rejects(recoverLocalAuth({ repoRoot: root, signal: controller.signal, ...docker }), /prepare_postgres_and_redis.*Backend is stopped/);
  assert.deepEqual(docker.calls.map(call => call.kind), ['stop', 'state', 'dependencies', 'stop', 'state']);
  assert.equal(docker.calls.at(-1).options.signal, undefined, 'cleanup ignores the cancelled signal');
  await assertClean(root, envFile);
});

test('a missing Docker binary and an already cancelled request cannot leave the API restarted', async t => {
  const { root, envFile } = await fixture(t);
  const spawnImpl = (command, args, options) => spawn(path.join(root, 'missing-docker'), args, options);
  await assert.rejects(recoverLocalAuth({ repoRoot: root, spawnImpl }), /stop_backend.*stop could not be confirmed/);
  assert.equal(await fsp.readFile(envFile, 'utf8'), ORIGINAL);
  await assertClean(root, envFile);
  const controller = new AbortController();
  controller.abort(new Error('private cancellation reason'));
  const docker = fakeDocker();
  await assert.rejects(recoverLocalAuth({ repoRoot: root, signal: controller.signal, ...docker }), error => {
    assert.match(error.message, /cancelled before/);
    assert.doesNotMatch(error.message, /private cancellation/);
    return true;
  });
  assert.equal(docker.calls.length, 0);
});

test('CLI accepts only its help switch or no arguments', () => {
  assert.deepEqual(parseArguments([]), { help: false });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.deepEqual(parseArguments(['-h']), { help: true });
  assert.throws(() => parseArguments(['--force']), /Usage:/);
  assert.throws(() => parseArguments(['--help', '--help']), /Usage:/);
});
