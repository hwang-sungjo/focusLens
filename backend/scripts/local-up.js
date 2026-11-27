const { spawn } = require('node:child_process');
const path = require('node:path');
const { ensureLocalEnv } = require('./local-env');

function composeArgs(repoRoot) {
  return ['compose', '--project-directory', repoRoot, '-f', path.join(repoRoot, 'docker-compose.yml')];
}

const upArgs = ['up', '-d', '--build', '--wait', '--wait-timeout', '180'];

async function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  const env = await ensureLocalEnv({ repoRoot });
  console.log(`Local environment ${env.created ? 'created' : 'preserved'}: ${env.path}`);
  const child = spawn('docker', [...composeArgs(repoRoot), ...upArgs], {
    cwd: repoRoot, env: { ...process.env, LOCAL_ENV_FILE: env.path }, stdio: 'inherit',
  });
  child.on('error', () => {
    console.error('Could not start Docker Compose. Check that Docker Desktop is installed and running.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Local startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { composeArgs, upArgs };
