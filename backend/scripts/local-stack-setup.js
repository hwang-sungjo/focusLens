const fs = require('node:fs');
const path = require('node:path');
const { defaultAiPython } = require('./local-ai-python');

function frontendInstalled(frontend) {
  const expected = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'), 'utf8'));
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(frontend, 'node_modules/.package-lock.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
  if (!installed?.packages || expected.lockfileVersion !== installed.lockfileVersion) return false;
  if (!fs.existsSync(path.join(frontend, 'node_modules/vite/bin/vite.js'))) return false;
  return Object.entries(expected.packages).every(([location, pkg]) => {
    if (!location) return true; // The installed lock omits the root package.
    const actual = installed.packages[location];
    if (!actual) return Boolean(pkg.optional);
    return actual.version === pkg.version && actual.integrity === pkg.integrity
      && fs.existsSync(path.join(frontend, location, 'package.json'));
  });
}

async function prepareFrontend({ repoRoot, run }) {
  const frontend = path.join(repoRoot, 'frontend');
  if (frontendInstalled(frontend)) return;
  console.log('프런트엔드 의존성을 설치합니다.');
  const args = ['ci', '--prefix', frontend, '--include=dev', '--include=optional'];
  // Invoking npm's JS entry also works on Windows, where npm.cmd needs a shell.
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (fs.existsSync(cli)) {
    await run(process.execPath, [cli, ...args]);
  } else {
    await run('npm', args);
  }
}

async function prepareAi({ repoRoot, run, env = process.env }) {
  const configured = env.FOCUSLENS_AI_PYTHON || env.AI3_PYTHON || env.AI2_PYTHON;
  const venv = path.join(repoRoot, '.local', 'ai-venv');
  const managedPython = path.join(venv, 'bin', 'python');
  let python = configured || defaultAiPython(repoRoot);
  if (!configured && python !== managedPython) {
    const bundled = path.join(repoRoot, '.local', 'python-3.11', 'bin', 'python3.11');
    const base = fs.existsSync(bundled) ? bundled : python;
    console.log('프로젝트에 Python 3.11 가상환경을 만듭니다.');
    try {
      await run(base, ['-m', 'venv', venv]);
    } catch (error) {
      throw new Error('AI 가상환경을 만들 수 없습니다. Python 3.11 및 venv 설치를 확인하세요.', { cause: error });
    }
    python = managedPython;
  }
  try {
    await run(python, ['-c', 'import sys; sys.exit(sys.version_info[:2] != (3, 11))'], { quiet: true });
  } catch (error) {
    throw new Error(`AI용 Python 3.11 실행 파일을 확인하세요: ${python}`, { cause: error });
  }
  const probe = ['-B', '-c', 'import fcntl, httpx; from focuslens_ai.mediapipe_runner import FaceLandmarkerRunner'];
  try {
    await run(python, probe, { quiet: true });
    return python;
  } catch (error) {
    if (path.resolve(repoRoot, python) !== managedPython) {
      throw new Error(`지정한 Python 환경에 AI 실행 패키지가 필요합니다. 저장소 루트에서 "${python}" -m pip install -e ./ai 를 실행하세요.`, { cause: error });
    }
  }
  console.log('AI 가상환경에 측정 패키지를 설치합니다.');
  await run(python, ['-m', 'pip', 'install', '-e', path.join(repoRoot, 'ai')]);
  await run(python, probe);
  return python;
}

module.exports = { prepareFrontend, prepareAi };
