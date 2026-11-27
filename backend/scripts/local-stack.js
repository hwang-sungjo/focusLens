const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ensureLocalEnv } = require('./local-env');
const { composeArgs, upArgs } = require('./local-up');
const { probeAi, probeBackend, probeFrontend } = require('./local-stack-probes');
const { prepareFrontend, prepareAi } = require('./local-stack-setup');
const { acquireLauncher } = require('./local-stack-lock');

const repoRoot = path.resolve(__dirname, '../..');
const windows = process.platform === 'win32';

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.href !== url.origin + '/') {
    throw new Error('로컬 서비스 주소를 http://localhost:포트 또는 http://127.0.0.1:포트 형식으로 지정해 주세요.');
  }
  return url;
}

// POSIX child process groups let us also stop workers spawned by Vite, pip or npm.
function launch(file, args, { env = process.env, cwd = repoRoot, quiet = false, capture = false } = {}) {
  const child = spawn(file, args, {
    cwd, env, detached: !windows, windowsHide: true,
    stdio: ['ignore', capture || quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'],
  });
  let output = '';
  if (child.stdout) child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr?.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${path.basename(file)} 실행이 끝났습니다 (${signal || code}).`));
    });
  });
  function kill(signal) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (windows) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  return { done, kill };
}

async function main() {
  const frontend = localUrl(process.env.LOCAL_CORS_ORIGIN || 'http://localhost:5173');
  const apiPort = process.env.LOCAL_API_PORT || '3000';
  const api = localUrl(`http://127.0.0.1:${apiPort}`);
  const ai = localUrl(process.env.VITE_LOCAL_AI_ORIGIN || 'http://127.0.0.1:4317');
  const loginUrl = frontend.origin + '/login';
  const release = await acquireLauncher(repoRoot);
  if (!release) {
    console.log(`이 저장소에서 npm start가 이미 실행 중입니다. 기존 터미널을 확인하세요. ${loginUrl}`);
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;
  let interrupted = false;
  const onSignal = () => { interrupted = true; controller.abort(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const children = new Set();
  let ownedServices = [];
  let composeEnv = process.env;
  function start(file, args, options) {
    signal.throwIfAborted();
    const child = launch(file, args, options);
    children.add(child);
    let force;
    const stop = () => {
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 8000);
      force.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    const remove = () => {
      clearTimeout(force);
      signal.removeEventListener('abort', stop);
      children.delete(child);
    };
    child.done.then(remove, remove);
    return child;
  }
  const run = (file, args, options) => start(file, args, options).done;
  const compose = args => [...composeArgs(repoRoot), ...args];
  function serve(label, file, args, options) {
    const child = start(file, args, options);
    child.done.then(
      () => controller.abort(new Error(`${label} 서비스가 종료됐습니다.`)),
      error => controller.abort(new Error(`${label} 서비스 실행 실패: ${error.message}`)),
    );
  }
  const components = [
    { name: '백엔드', url: api.origin, probe: () => probeBackend(api.origin) },
    { name: '프런트엔드', url: frontend.origin, probe: () => probeFrontend(frontend.origin) },
  ];
  if (!windows) components.push({ name: 'AI', url: ai.origin, probe: () => probeAi(ai.origin, frontend.origin) });
  try {
    if (windows) console.log('Windows에서는 백엔드와 웹 화면을 실행합니다. 카메라 AI는 macOS에서 사용할 수 있습니다.');
    const states = await Promise.all(components.map(c => c.probe()));
    for (const [i, state] of states.entries()) {
      const { name, url } = components[i];
      if (state === 'conflict') throw new Error(`${name} 주소 ${url}의 포트를 사용 중입니다. 해당 프로그램을 확인해 주세요.`);
      if (state === 'compatible') console.log(`${name} 재사용  ${url}`);
    }
    if (states.every(state => state === 'compatible')) {
      console.log(`FocusLens가 이미 준비되어 있습니다. ${loginUrl}`);
      return;
    }
    const [needApi, needFrontend, needAi] = states.map(state => state === 'available');
    if (needApi) {
      try {
        await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
      } catch {
        signal.throwIfAborted();
        if (process.platform === 'linux') throw new Error('먼저 Docker 엔진을 실행해 주세요.');
        console.log('Docker Desktop을 시작합니다.');
        try { await run('docker', ['desktop', 'start']); }
        catch { throw new Error('Docker Desktop을 설치하고 실행한 뒤 npm start를 다시 입력해 주세요.'); }
      }
      const envFile = await ensureLocalEnv({ repoRoot });
      composeEnv = { ...process.env, LOCAL_ENV_FILE: envFile.path };
    }
    if (needFrontend) await prepareFrontend({ repoRoot, run });
    const python = needAi ? await prepareAi({ repoRoot, run }) : null;
    if (needApi) {
      const running = await run('docker', compose(['ps', '--services', '--status', 'running']), { env: composeEnv, capture: true });
      ownedServices = ['backend', 'migrate', 'redis', 'postgres'].filter(s => !running.split(/\s+/).includes(s));
      await run('docker', compose(upArgs), { env: composeEnv });
    }
    if (needAi) serve('AI', python, ['-B', path.join(__dirname, 'local_ai_web.py'),
      '--port', ai.port || '80', '--base-url', api.origin, '--frontend-origin', frontend.origin]);
    if (needFrontend) {
      const cwd = path.join(repoRoot, 'frontend');
      serve('프런트엔드', process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'),
        '--host', frontend.hostname, '--port', frontend.port || '80', '--strictPort'], {
        cwd, env: {
          ...(process.env.LOCAL_API_PORT || process.env.LOCAL_CORS_ORIGIN
            ? { VITE_API_BASE_URL: `http://${frontend.hostname}:${apiPort}` } : {}),
          ...process.env,
        },
      });
    }

    const deadline = Date.now() + 30000;
    for (;;) {
      signal.throwIfAborted();
      const readiness = await Promise.all(components.map(c => c.probe()));
      if (readiness.every(value => value === 'compatible')) break;
      if (Date.now() >= deadline) {
        const pending = components.filter((c, i) => readiness[i] !== 'compatible').map(c => c.name);
        throw new Error(`준비 상태를 확인할 수 없습니다: ${pending.join(', ')}`);
      }
      await delay(250, undefined, { signal });
    }
    console.log(`\nFocusLens 준비 완료  ${loginUrl}\n종료하려면 이 터미널에서 Ctrl+C를 누르세요.\n`);
    // Keep listening for Ctrl+C even when the only service we started is in Docker.
    for (;;) await delay(86400000, undefined, { signal });
  } catch (error) {
    if (!interrupted) throw signal.aborted ? signal.reason : error;
  } finally {
    controller.abort();
    try {
      await Promise.allSettled([...children].map(child => child.done));
      if (ownedServices.length) {
        console.log('이번 실행에서 시작한 Docker 서비스를 종료합니다.');
        await launch('docker', compose(['stop', ...ownedServices]), { env: composeEnv }).done;
      }
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await release();
    }
  }
}

main().catch(error => {
  console.error(`FocusLens 실행 오류: ${error.message}`);
  process.exitCode = 1;
});
