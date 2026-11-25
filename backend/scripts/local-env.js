// Prepare local configuration without replacing an existing developer environment.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const REQUIRED_KEYS = ['NODE_ENV', 'PORT', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'CORS_ORIGIN'];

function validateEnvironment(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const closingQuote = value.indexOf(value[0], 1);
      value = closingQuote >= 0 ? value.slice(1, closingQuote) : value.slice(1);
    } else {
      value = value.split('#', 1)[0];
    }
    values.set(match[1], value.trim());
  }
  const missing = REQUIRED_KEYS.filter(key => !values.get(key));
  if (missing.length) throw new Error(`Local environment requires nonempty keys: ${missing.join(', ')}`);
}

async function readExisting(file) {
  try {
    validateEnvironment(await fs.readFile(file, 'utf8'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureLocalEnv({ repoRoot = path.resolve(__dirname, '../..'), envFile = process.env.LOCAL_ENV_FILE } = {}) {
  const file = path.resolve(repoRoot, envFile || 'backend/.env');
  if (await readExisting(file)) return { created: false, path: file };

  const template = await fs.readFile(path.join(repoRoot, 'backend/.env.local.example'), 'utf8');
  const content = template.replace(/^[ \t]*(?:export[ \t]+)?JWT_SECRET[ \t]*=.*$/gm, `JWT_SECRET=${randomBytes(32).toString('hex')}`);
  validateEnvironment(content);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Publishing a finished file keeps concurrent setup calls from seeing partial content.
    try {
      await fs.link(temporary, file);
      return { created: true, path: file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await readExisting(file);
      return { created: false, path: file };
    }
  } finally {
    await fs.unlink(temporary);
  }
}

if (require.main === module) {
  ensureLocalEnv().then(result => {
    console.log(`Local environment ${result.created ? 'created' : 'preserved'} at ${result.path}`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { ensureLocalEnv };
