// LBE-2: upgrade and restore only disposable copies of a supplied custom archive.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ensureLocalEnv } = require('./local-env');
const { backupDatabase } = require('./local-db-backup');
const { restoreDatabase } = require('./local-db-restore');

const repoRoot = path.resolve(__dirname, '../..');
const quote = value => `"${value.replace(/"/g, '""')}"`;
const literal = value => `'${value.replace(/'/g, "''")}'`;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else if (argv[index] === '--backup' && !options.backup && argv[index + 1]
      && !argv[index + 1].startsWith('--')) options.backup = argv[++index];
    else throw new Error('Usage: node backend/scripts/verify-local-preservation.js --backup FILE');
  }
  if (!options.help && !options.backup) throw new Error('--backup FILE is required.');
  return options;
}

// Never inherit subprocess output: seed prints credentials and SQL can contain private rows.
async function command(args, { env, operation, input, digest = false, signal, program = 'docker' }) {
  signal?.throwIfAborted();
  const grouped = program === process.execPath && process.platform !== 'win32';
  const child = spawn(program, args, {
    cwd: repoRoot, env, signal, detached: grouped,
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'],
  });
  const terminate = signalName => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signalName);
      else child.kill(signalName);
    } catch (_error) { /* The process may already have exited. */ }
  };
  let output = '';
  const hash = digest ? createHash('sha256') : null;
  child.stdout.on('data', chunk => {
    if (hash) hash.update(chunk);
    else if (output.length < 16 * 1024 * 1024) output += chunk.toString('utf8');
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const completed = new Promise((resolve, reject) => {
    child.once('error', error => reject(new Error(`${operation} could not start (${error.code || 'process error'}).`)));
    child.once('close', (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`${operation} failed (${killedBy || `exit ${code}`}).`));
    });
  });
  const pending = [completed];
  if (input) pending.push(pipeline(input, child.stdin, { signal }));
  try {
    await Promise.all(pending);
  } catch (error) {
    terminate('SIGTERM');
    input?.destroy();
    const forceKill = setTimeout(() => terminate('SIGKILL'), 1000);
    forceKill.unref();
    try { await Promise.allSettled([...pending, closed]); } finally { clearTimeout(forceKill); }
    // Stream failures may carry file contents or connection diagnostics in their messages.
    throw new Error(`${operation} failed.`, { cause: error });
  }
  return hash ? hash.digest('hex') : output.trim();
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function tokenFor(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId, role: 'USER', iat: now, exp: now + 3600,
  })}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

async function request(baseUrl, route, { method = 'GET', body, token } = {}, status = 200) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, `API ${method} request returned unexpected status`);
  const envelope = await response.json();
  assert.ok(envelope.success === true && envelope.error === '' && envelope.data, 'API response envelope');
  return envelope.data;
}

function jsonDigest(value) {
  // Canonicalize nested objects so JSONB key order never causes false differences.
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(
      Object.keys(item).sort().map(key => [key, canonical(item[key])]),
    );
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node backend/scripts/verify-local-preservation.js --backup FILE');
    console.log('Reads a pg_dump custom archive; all writes use a disposable Compose project.');
    return;
  }
  const archive = path.resolve(options.backup);
  assert.ok((await fsp.stat(archive)).isFile(), 'Backup must be a regular file');
  const handle = await fsp.open(archive, 'r');
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    assert.ok(magic.toString('ascii') === 'PGDMP', 'Backup must use pg_dump custom format');
  } finally { await handle.close(); }
  const originalArchiveDigest = await fileDigest(archive);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'focuslens-preservation-'));
  const project = `focuslens-preservation-${randomUUID()}`;
  const restoreApi = `${project}-restore-api`;
  const env = {
    ...process.env, COMPOSE_PROJECT_NAME: project,
    LOCAL_ENV_FILE: path.join(temporary, '.env'),
    LOCAL_API_PORT: '0', LOCAL_DB_PORT: '0', LOCAL_REDIS_PORT: '0',
    LOCAL_CORS_ORIGIN: 'http://localhost:5173', LOCAL_ROLLUP_ENABLED: 'false',
  };
  // Prevent an inherited Compose selection from targeting the developer's project.
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const compose = ['compose', '--project-directory', repoRoot, '-p', project,
    '-f', path.join(repoRoot, 'docker-compose.yml')];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let cleanupError;
  let result;
  let stage = 'prepare';
  const run = (args, operation, extra = {}) => command(args, {
    env, operation, signal: controller.signal, ...extra,
  });
  const sql = (query, database = 'focuslens', extra = {}) => run([
    ...compose, 'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'focuslens', '-d', database, '-Atc', query,
  ], 'Database query', extra);
  const discover = async (database = 'focuslens') => JSON.parse(await sql(`
    SELECT COALESCE(json_agg(t ORDER BY table_name), '[]'::json) FROM (
      SELECT c.table_name, json_agg(c.column_name ORDER BY c.ordinal_position) AS columns
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY c.table_name
    ) t`, database));
  const fingerprints = async (specifications, database = 'focuslens', predicates = {}) => {
    const rows = [];
    for (const specification of specifications) {
      const table = `public.${quote(specification.table_name)}`;
      const where = predicates[specification.table_name] ? ` WHERE ${predicates[specification.table_name]}` : '';
      const count = await sql(`SELECT count(*) FROM ${table}${where}`, database);
      const columns = specification.columns.map(quote).join(', ');
      const sha256 = await sql(`COPY (
        SELECT row_to_json(data)::text FROM (SELECT ${columns} FROM ${table}${where}) data
        ORDER BY row_to_json(data)::text COLLATE "C"
      ) TO STDOUT`, database, { digest: true });
      rows.push({ table: specification.table_name, columns: specification.columns, count, sha256 });
    }
    return rows;
  };
  const compare = (actual, expected, label) => assert.ok(
    jsonDigest(actual) === jsonDigest(expected), `${label}: table counts or row digests changed`,
  );
  const restore = (file, database) => run([
    ...compose, 'exec', '-T', 'postgres', 'pg_restore', '--exit-on-error',
    '--no-owner', '--no-privileges', '-U', 'focuslens', '-d', database,
  ], 'Archive restore', { input: fs.createReadStream(file) });
  const apiOrigin = async (name) => {
    const address = await run(name ? ['port', name, '3000/tcp'] : [...compose, 'port', 'backend', '3000'], 'API port lookup');
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'API must bind to an isolated loopback port');
    return `http://${address}`;
  };
  const waitForApi = async origin => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      try {
        const health = await request(origin, '/health');
        if (health.db === 'connected' && health.redis === 'connected') return;
      } catch (_error) { /* The freshly launched process may still be connecting. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Restored API readiness timed out.');
  };
  const progress = value => { stage = value; console.log(JSON.stringify({ stage })); };
  try {
    await ensureLocalEnv({ repoRoot, envFile: env.LOCAL_ENV_FILE });
    const configuration = await fsp.readFile(env.LOCAL_ENV_FILE, 'utf8');
    const secret = configuration.match(/^JWT_SECRET=(.+)$/m)?.[1];
    assert.ok(secret, 'Isolated environment has a signing secret');
    progress('restore_original_into_isolated_project');
    await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis'], 'Start isolated databases');
    await restore(archive, 'focuslens');
    const initialSpecifications = await discover();
    const originalSpecifications = initialSpecifications.filter(item => item.table_name !== '_prisma_migrations');
    const baseline = await fingerprints(originalSpecifications);
    const migrationSpecification = initialSpecifications.find(item => item.table_name === '_prisma_migrations');
    assert.ok(migrationSpecification, 'Source archive includes its migration history');
    const initialMigrationIds = JSON.parse(await sql("SELECT COALESCE(json_agg(id ORDER BY id), '[]'::json) FROM _prisma_migrations"));
    const initialMigrationPredicate = {
      _prisma_migrations: initialMigrationIds.length ? `id IN (${initialMigrationIds.map(literal).join(', ')})` : 'FALSE',
    };
    const initialMigrationFingerprint = await fingerprints([migrationSpecification], 'focuslens', initialMigrationPredicate);
    const initialMigrations = Number(await sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'));
    const originals = JSON.parse(await sql(`SELECT json_build_object(
      'user', (SELECT json_build_object('id', u.id) FROM users u
        JOIN user_privacy_settings p ON p.user_id = u.id ORDER BY u.id LIMIT 1),
      'session', (SELECT json_build_object('id', id, 'user_id', user_id) FROM sessions ORDER BY id LIMIT 1),
      'report', (SELECT json_build_object('id', r.id, 'session_id', s.id, 'user_id', s.user_id)
        FROM reports r JOIN sessions s ON s.id = r.session_id
        WHERE s.status = 'COMPLETED' AND s.ended_at IS NOT NULL ORDER BY r.id LIMIT 1)
    )`));

    progress('upgrade_clone_and_compare_original_columns');
    await run(['backend/scripts/local-up.js'], 'Build and start upgraded local stack', { program: process.execPath });
    let origin = await apiOrigin();
    await waitForApi(origin);
    compare(await fingerprints(originalSpecifications), baseline, 'Migration preservation');
    compare(await fingerprints([migrationSpecification], 'focuslens', initialMigrationPredicate),
      initialMigrationFingerprint, 'Preexisting migration history preservation');
    const originalLogColumns = originalSpecifications.find(item => item.table_name === 'concentration_logs')?.columns || [];
    if (!originalLogColumns.includes('minute_index')) {
      const mismatches = await sql(`SELECT count(*) FROM (
        SELECT minute_index, row_number() OVER (PARTITION BY session_id ORDER BY logged_at, id) AS expected
        FROM concentration_logs
      ) numbered WHERE minute_index <> expected`);
      assert.equal(mismatches, '0', 'Legacy minute indices follow the documented per-session order');
    }
    for (const column of ['client_log_id', 'measured_at']) {
      if (!originalLogColumns.includes(column)) {
        assert.equal(await sql(`SELECT count(*) FROM concentration_logs WHERE ${quote(column)} IS NOT NULL`),
          '0', 'New optional log columns retain NULL for legacy rows');
      }
    }
    const migrations = Number(await sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'));
    const committedMigrations = (await fsp.readdir(path.join(repoRoot, 'prisma/migrations'), { withFileTypes: true }))
      .filter(item => item.isDirectory()).map(item => item.name).sort();
    const appliedMigrations = JSON.parse(await sql(`SELECT COALESCE(json_agg(migration_name), '[]'::json)
      FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`));
    assert.ok(committedMigrations.every(name => appliedMigrations.includes(name)),
      'Every committed repository migration was applied without removing additional source history');
    const views = Number(await sql("SELECT count(*) FROM information_schema.views WHERE table_schema = 'public' AND table_name LIKE 'v_%'"));
    assert.equal(views, 5, 'Expected all 5 query Views');
    const allSpecifications = await discover();

    progress('seed_twice_and_compare_all_tables');
    const seed = () => run([...compose, 'run', '--rm', '--no-deps', '--entrypoint', 'node',
      'migrate', '/app/prisma/seed.js'], 'Run seed in migration image');
    await seed();
    const seededOnce = await fingerprints(allSpecifications);
    await seed();
    compare(await fingerprints(allSpecifications), seededOnce, 'Seed idempotence');

    progress('create_http_fixture_and_read_original_records');
    const unique = randomUUID();
    const credentials = { email: `preservation-${unique}@example.test`, password: randomBytes(24).toString('hex') };
    const registered = await request(origin, '/api/auth/register', {
      method: 'POST', body: { ...credentials, name: 'Preservation verification', nickname: `preserve-${unique.slice(0, 16)}` },
    }, 201);
    const login = await request(origin, '/api/auth/login', { method: 'POST', body: credentials });
    assert.ok(login.user_id === registered.user_id && login.access_token, 'Fixture login identifies the registered account');
    const started = await request(origin, '/api/sessions/start', { method: 'POST', token: login.access_token }, 201);
    const ended = await request(origin, `/api/sessions/${started.session_id}/end`, { method: 'POST', token: login.access_token });
    assert.ok(ended.status === 'COMPLETED' && ended.report_id, 'Fixture session completed with a report');
    const checks = [];
    const addCheck = (label, route, userId) => checks.push({ label, route, userId });
    addCheck('fixture_account', '/api/users/me/privacy', registered.user_id);
    addCheck('fixture_session', `/api/sessions/${started.session_id}`, registered.user_id);
    addCheck('fixture_report', `/api/reports/${started.session_id}`, registered.user_id);
    if (originals.user) addCheck('original_account', '/api/users/me/privacy', originals.user.id);
    if (originals.session) addCheck('original_session', `/api/sessions/${originals.session.id}`, originals.session.user_id);
    if (originals.report) addCheck('original_report', `/api/reports/${originals.report.session_id}`, originals.report.user_id);
    const apiDigests = async base => {
      const digests = [];
      for (const check of checks) {
        const data = await request(base, check.route, { token: tokenFor(check.userId, secret) });
        digests.push({ check: check.label, sha256: jsonDigest(data) });
      }
      return digests;
    };
    const beforeRestartApi = await apiDigests(origin);
    const beforeRestart = await fingerprints(allSpecifications);

    progress('restart_with_existing_volumes');
    await run([...compose, 'down'], 'Stop isolated stack while retaining volumes');
    await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '180'], 'Restart isolated stack');
    origin = await apiOrigin();
    await waitForApi(origin);
    compare(await fingerprints(allSpecifications), beforeRestart, 'Volume restart preservation');
    compare(await apiDigests(origin), beforeRestartApi, 'API records after restart');

    progress('backup_upgraded_clone_and_restore_second_database');
    const postgres = await run([...compose, 'ps', '-q', 'postgres'], 'Find isolated PostgreSQL');
    assert.match(postgres, /^[a-f0-9]+$/, 'Expected one isolated PostgreSQL container ID');
    const backup = await backupDatabase({
      repoRoot, container: postgres, outputPath: path.join(temporary, 'upgraded.dump'), signal: controller.signal,
    });
    const restoredDatabase = `focuslens_restore_${randomBytes(10).toString('hex')}`;
    await restoreDatabase({
      repoRoot, container: postgres, inputPath: backup.path, database: restoredDatabase, signal: controller.signal,
    });
    assert.ok(jsonDigest(await discover(restoredDatabase)) === jsonDigest(allSpecifications), 'Restored table and column inventory');
    compare(await fingerprints(allSpecifications, restoredDatabase), beforeRestart, 'Archive restore preservation');
    await run([...compose, 'run', '--no-deps', '-d', '--name', restoreApi,
      '--publish', '127.0.0.1::3000', '-e',
      `DATABASE_URL=postgresql://focuslens:focuslens_pw@postgres:5432/${restoredDatabase}?schema=public`,
      'backend'], 'Start API against restored database');
    const restoredOrigin = await apiOrigin(restoreApi);
    await waitForApi(restoredOrigin);
    compare(await apiDigests(restoredOrigin), beforeRestartApi, 'API records after archive restore');
    compare(await fingerprints(allSpecifications, restoredDatabase), beforeRestart, 'Read-only restored API checks');
    assert.ok(await fileDigest(archive) === originalArchiveDigest, 'Input archive remains unchanged');
    result = {
      result: 'LBE-2 data preservation passed', original_archive_sha256: originalArchiveDigest,
      initial_migrations: initialMigrations, upgraded_migrations: migrations, query_views: views,
      repository_migrations_confirmed: committedMigrations.length, preexisting_migration_history_preserved: true,
      original_tables: baseline.map(({ table, count, sha256 }) => ({ table, count, sha256 })),
      seed_idempotent: true, volume_restart_preserved: true,
      upgraded_backup: { bytes: backup.bytes, sha256: backup.sha256, archive_verified: backup.archiveVerified },
      restored_tables_match: true, api_checks: checks.map(check => check.label),
      restored_api_matches: true, original_services_untouched: true,
    };
  } catch (error) {
    throw new Error(`LBE-2 failed at ${stage}: ${error.message}`, { cause: error });
  } finally {
    // Only the randomly named project and its private temporary directory are removed.
    try {
      await command(['rm', '-f', restoreApi], { env, operation: 'Remove restored API' }).catch(() => {});
      await command([...compose, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], {
        env, operation: 'Remove isolated verification project',
      });
    } catch (error) { cleanupError = error; }
    try { await fsp.rm(temporary, { recursive: true, force: true }); } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    if (cleanupError) throw new Error('Verification project cleanup failed; inspect the isolated preservation project in Docker.');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ result: 'LBE-2 failed', error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { parseArguments };
