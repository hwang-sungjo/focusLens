// Build and start the same Compose services as local:up in a disposable project.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function command(program, args, env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: repoRoot, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let output = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${program} ${args.slice(0, 3).join(' ')} failed (${signal || code})`));
    });
  });
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-local-startup-'));
  const project = `focuslens-local-${randomUUID()}`;
  const env = {
    ...process.env, COMPOSE_PROJECT_NAME: project,
    LOCAL_ENV_FILE: path.join(temporary, '.env'),
    LOCAL_API_PORT: '0', LOCAL_DB_PORT: '0', LOCAL_REDIS_PORT: '0',
    LOCAL_CORS_ORIGIN: 'http://localhost:5173', LOCAL_ROLLUP_ENABLED: 'false',
  };
  const compose = ['compose', '-p', project, '-f', path.join(repoRoot, 'docker-compose.yml')];
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await command(process.execPath, ['backend/scripts/local-up.js'], env);
    assert.equal(interrupted, false, 'verification interrupted');
    const address = await command('docker', [...compose, 'port', 'backend', '3000'], env, true);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const baseUrl = `http://${address}`;
    await command(process.execPath, ['backend/scripts/verify-local-startup.js'], { ...env, LOCAL_VERIFY_URL: baseUrl });
    const migrations = await command('docker', [
      ...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'focuslens', '-d', 'focuslens', '-Atc',
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    ], env, true);
    assert.equal(migrations, '11', 'all committed migrations were applied');
    const views = await command('docker', [
      ...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'focuslens', '-d', 'focuslens', '-Atc',
      "SELECT count(*) FROM information_schema.views WHERE table_schema='public' AND table_name LIKE 'v_%'",
    ], env, true);
    assert.equal(views, '5', 'all query Views were applied');
    console.log('LBE-1 fresh database: 11 migrations and 5 Views confirmed');
  } finally {
    try {
      await command('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], env);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}

main().catch(error => {
  console.error(`Local stack verification failed: ${error.message}`);
  process.exitCode = 1;
});
