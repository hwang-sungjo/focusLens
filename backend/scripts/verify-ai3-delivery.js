// AI-3 exercises the delivery adapter against real HTTP, PostgreSQL and Redis.
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('../node_modules/jsonwebtoken');

function configureEnvironment() {
  for (const name of ['AI1_DATABASE_URL', 'AI1_REDIS_URL']) {
    assert.ok(process.env[name], `Missing ${name}; run npm run verify:ai3`);
    const value = new URL(process.env[name]);
    assert.ok(['127.0.0.1', 'localhost'].includes(value.hostname) && value.port);
    if (name === 'AI1_DATABASE_URL') {
      assert.ok(['postgres:', 'postgresql:'].includes(value.protocol));
      assert.match(value.pathname, /^\/focuslens_ai1(?:_\w+)?$/);
    } else assert.equal(value.protocol, 'redis:');
  }
  Object.assign(process.env, {
    DATABASE_URL: process.env.AI1_DATABASE_URL,
    REDIS_URL: process.env.AI1_REDIS_URL,
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_EXPIRES_IN: '1h',
  });
}

async function worker(input) {
  const env = { ...process.env };
  for (const name of ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'AI1_DATABASE_URL', 'AI1_REDIS_URL', 'AI1_PG_PASSWORD']) delete env[name];
  const child = spawn(process.env.AI3_PYTHON || process.env.AI2_PYTHON || 'python3.11', ['-B', path.join(__dirname, 'ai3_worker.py')], {
    env, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 100_000) child.kill('SIGKILL');
  });
  const stop = () => child.kill('SIGKILL');
  process.once('exit', stop);
  const timer = setTimeout(stop, 30_000);
  child.stdin.end(JSON.stringify(input));
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 0, `AI-3 worker exited with ${signal || code}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    process.removeListener('exit', stop);
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function faultProxy(upstream, faults, evidence) {
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const isLog = req.method === 'POST' && req.url.endsWith('/log');
      const isRefresh = req.url === '/api/auth/refresh';
      const isEnd = req.method === 'POST' && req.url.endsWith('/end');
      if (isLog) evidence.log_payloads.push(JSON.parse(body.toString()));
      if (isEnd) evidence.end_requests += 1;
      if (isRefresh) evidence.refresh_requests += 1;
      if (isLog && faults.offline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, data: {}, error: 'fixture outage' }));
        return;
      }
      if (isLog && faults.rateOnce) {
        faults.rateOnce = false;
        evidence.rate_limited += 1;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ success: false, data: {}, error: 'fixture rate limit' }));
        return;
      }
      if (isRefresh && faults.refreshUnavailableOnce) {
        faults.refreshUnavailableOnce = false;
        evidence.refresh_unavailable += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, data: {}, error: 'fixture refresh outage' }));
        return;
      }
      const response = await fetch(upstream + req.url, {
        method: req.method,
        headers: {
          ...(req.headers.authorization && { Authorization: req.headers.authorization }),
          ...(body.length && { 'Content-Type': 'application/json' }),
        },
        ...(body.length && { body }),
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = await response.text();
      if (isLog) evidence.log_statuses.push(response.status);
      if (isRefresh) evidence.refresh_statuses.push(response.status);
      if (isLog && faults.dropLogOnce && response.status === 200) {
        faults.dropLogOnce = false;
        evidence.lost_log_ack += 1;
        res.destroy();
        return;
      }
      if (isEnd && faults.dropEndOnce && response.status === 200) {
        faults.dropEndOnce = false;
        evidence.lost_end_ack += 1;
        res.destroy();
        return;
      }
      if (isRefresh && faults.dropRefreshOnce && response.status === 200) {
        faults.dropRefreshOnce = false;
        evidence.lost_refresh_ack += 1;
        res.destroy();
        return;
      }
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'X-Request-ID': response.headers.get('x-request-id') || 'ai3-proxy',
      });
      res.end(responseBody);
    } catch (_error) {
      if (!res.destroyed) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, data: {}, error: 'fixture forwarding failure' }));
      }
    }
  });
}

async function verify(base, proxy, db, temp, faults, evidence) {
  async function request(method, route, token, body, status = 200) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, status, `${method} ${route}`);
    const envelope = await response.json();
    assert.equal(envelope.success, status < 400);
    return envelope.data;
  }
  async function account() {
    const id = randomUUID();
    const body = { email: `ai3-${id}@example.test`, password: randomBytes(18).toString('hex') };
    await request('POST', '/api/auth/register', null, { ...body, name: 'AI-3', nickname: `ai3-${id.slice(0, 16)}` }, 201);
    return request('POST', '/api/auth/login', null, body);
  }
  async function sessionFor(credentials) {
    const session = await request('POST', '/api/sessions/start', credentials.access_token, {}, 201);
    const start = Date.parse(session.started_at) - 245_000;
    await db.sessions.update({ where: { id: session.session_id }, data: { started_at: new Date(start) } });
    return { ...session, start };
  }
  function payload(session, minute, total = 79.65) {
    const scores = total === 0 ? { gaze: 0, blink: 0, head: 0, total: 0, face_detected: false }
      : total === 77 ? { gaze: 80, blink: 70, head: 90, total: 77, face_detected: true }
        : { gaze: 85.5, blink: 72, head: 90, total: 79.65, face_detected: true };
    return { ...scores, client_log_id: randomUUID(), measured_at: new Date(session.start + minute * 60_000).toISOString() };
  }
  function invoke(queue, session, credentials, operations, options = {}) {
    return worker({
      action: 'run', queue_path: path.join(temp, queue + '.sqlite'), base_url: proxy,
      session_id: session.session_id,
      credentials: { access_token: credentials.access_token, refresh_token: credentials.refresh_token },
      operations, options: { fast_retry: true, ...options },
    });
  }
  function result(output, index = 0) {
    assert.equal(output.ok, true, 'worker batch succeeded');
    assert.equal(output.results[index].ok, true, 'worker operation succeeded');
    return output.results[index].result;
  }
  function blocked(output, index, code) {
    assert.equal(output.results[index].ok, false, 'finish must be blocked');
    assert.equal(output.results[index].error.code, code);
  }

  await request('GET', '/health', null);
  const auth = await account();
  const session = await sessionFor(auth);
  const first = payload(session, 1);
  const second = payload(session, 2, 0);
  const third = payload(session, 3, 77);
  faults.offline = true;
  const outage = await invoke('main', session, auth, [
    { action: 'enqueue', payload: first }, { action: 'enqueue', payload: second },
    { action: 'enqueue', payload: third }, { action: 'drain' }, { action: 'records' },
  ]);
  assert.equal(result(outage, 3).pending, 3);
  const offlineRecords = result(outage, 4);
  assert.equal(offlineRecords.length, 3);
  assert.deepEqual(offlineRecords[0].payload, first, 'outbox payload is immutable');
  assert.equal(evidence.log_payloads.length, 9, 'initial attempt plus eight retries');
  for (const value of evidence.log_payloads) assert.deepEqual(value, first, 'same payload during outage');
  assert.equal(await db.concentration_logs.count({ where: { session_id: session.session_id } }), 0);
  const restart = await invoke('main', session, auth, [{ action: 'records' }, { action: 'finish' }], { max_retries: 0 });
  assert.deepEqual(result(restart)[0].payload, first, 'restart preserves the minute');
  blocked(restart, 1, 'pending_logs');
  assert.equal(evidence.end_requests, 0, 'no end request while offline logs remain');
  faults.offline = false;
  faults.dropLogOnce = true;
  const originalRefreshHash = createHash('sha256').update(auth.refresh_token).digest('hex');
  const expired = {
    ...auth,
    access_token: jwt.sign({ sub: auth.user_id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: -10 }),
  };
  faults.rateOnce = true;
  faults.dropEndOnce = true;
  const refreshStart = evidence.refresh_requests;
  const completed = await invoke('main', session, expired, [
    { action: 'drain' }, { action: 'finish' },
  ]);
  assert.equal(result(completed, 0).pending, 0);
  const end = result(completed, 1);
  assert.equal(evidence.lost_log_ack, 1);
  assert.equal(evidence.lost_end_ack, 1);
  assert.equal(evidence.refresh_requests - refreshStart, 1, 'single refresh for both pending minute logs');
  assert.equal(evidence.rate_limited, 1);
  const oldToken = await db.refresh_tokens.findUniqueOrThrow({ where: { token_hash: originalRefreshHash } });
  assert.ok(oldToken.used_at && oldToken.revoked_at && oldToken.replaced_by_token_id, 'refresh rotation persisted');
  const replacement = await db.refresh_tokens.findUniqueOrThrow({ where: { id: oldToken.replaced_by_token_id } });
  assert.equal(replacement.family_id, oldToken.family_id);
  const rows = await db.concentration_logs.findMany({ where: { session_id: session.session_id }, orderBy: { minute_index: 'asc' } });
  assert.equal(rows.length, 3, 'lost HTTP acknowledgement must not duplicate any log');
  assert.deepEqual(rows.map(value => value.focus_score), [79.65, 0, 77]);
  for (const [index, expected] of [first, second, third].entries()) {
    assert.equal(rows[index].client_log_id, expected.client_log_id);
    assert.equal(rows[index].measured_at.toISOString(), expected.measured_at);
    assert.equal(rows[index].minute_index, index + 1);
  }
  const report = await request('GET', `/api/reports/${session.session_id}`, auth.access_token);
  assert.equal(end.summary.total_logs, 3);
  assert.equal(end.summary.avg_focus_score, 52.22);
  assert.deepEqual(report.summary_json, end.summary);
  assert.deepEqual(report.timeline.map(value => value.focus_score), [79.65, 0, 77]);
  const storedReport = await db.reports.findUniqueOrThrow({ where: { session_id: session.session_id } });
  assert.deepEqual(storedReport.summary_json, end.summary);

  // A temporary refresh outage keeps credentials usable for a second drain.
  const auth2 = await account();
  const session2 = await sessionFor(auth2);
  const expired2 = { ...auth2, access_token: jwt.sign({ sub: auth2.user_id }, process.env.JWT_SECRET, { expiresIn: -10 }) };
  faults.refreshUnavailableOnce = true;
  const refreshOutage = await invoke('refresh-outage', session2, expired2, [
    { action: 'enqueue', payload: payload(session2, 1) }, { action: 'drain' },
    { action: 'drain' }, { action: 'finish' },
  ], { max_retries: 0 });
  assert.equal(result(refreshOutage, 1).pending, 1, 'refresh 503 keeps the log pending');
  assert.equal(result(refreshOutage, 2).pending, 0, 'same credentials recover after transient refresh outage');
  assert.equal(result(refreshOutage, 3).summary.total_logs, 1);
  assert.equal(evidence.refresh_unavailable, 1);

  // A real backend 409 needs explicit resolution before a session may end.
  const auth3 = await account();
  const session3 = await sessionFor(auth3);
  const accepted = payload(session3, 1);
  const conflict = payload(session3, 1, 77);
  const permanent = await invoke('conflict', session3, auth3, [
    { action: 'enqueue', payload: accepted }, { action: 'drain' },
    { action: 'enqueue', payload: conflict }, { action: 'drain' },
    { action: 'finish' }, { action: 'records' },
    { action: 'discard', client_log_id: conflict.client_log_id, reason: 'verified duplicate minute fixture' },
    { action: 'finish' },
  ]);
  assert.equal(result(permanent, 3).failed, 1);
  blocked(permanent, 4, 'failed_logs');
  const failed = result(permanent, 5).find(value => value.payload.client_log_id === conflict.client_log_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1, 'permanent conflict is not automatically retried');
  assert.equal(result(permanent, 7).summary.total_logs, 1);

  // Old refresh reuse revokes the family; expired-token workers require reauthentication.
  await request('POST', '/api/auth/refresh', null, { refresh_token: auth2.refresh_token }, 401);
  const revoked = await db.refresh_tokens.findMany({
    where: { user_id: auth2.user_id, family_id: (await db.refresh_tokens.findUniqueOrThrow({
      where: { token_hash: createHash('sha256').update(auth2.refresh_token).digest('hex') },
    })).family_id },
  });
  assert.ok(revoked.length >= 2 && revoked.every(value => value.revoked_at), 'reused refresh family is revoked');

  // Losing the refresh response must not cause the used token to be submitted again.
  const auth4 = await account();
  const session4 = await sessionFor(auth4);
  const expired4 = { ...auth4, access_token: jwt.sign({ sub: auth4.user_id }, process.env.JWT_SECRET, { expiresIn: -10 }) };
  faults.dropRefreshOnce = true;
  const uncertainRefresh = await invoke('lost-refresh', session4, expired4, [
    { action: 'enqueue', payload: payload(session4, 1) }, { action: 'drain' },
  ], { max_retries: 0 });
  assert.equal(result(uncertainRefresh, 1).pending, 1);
  assert.equal(evidence.lost_refresh_ack, 1);
  const refreshAttempts = evidence.refresh_requests;
  const restartedRefresh = await invoke('lost-refresh', session4, expired4, [
    { action: 'drain' }, { action: 'finish' },
  ], { max_retries: 0 });
  assert.equal(result(restartedRefresh, 0).status, 'authentication_required');
  blocked(restartedRefresh, 1, 'pending_logs');
  assert.equal(evidence.refresh_requests, refreshAttempts, 'ambiguous used refresh token is not replayed');
  const uncertainOld = await db.refresh_tokens.findUniqueOrThrow({
    where: { token_hash: createHash('sha256').update(auth4.refresh_token).digest('hex') },
  });
  const uncertainNew = await db.refresh_tokens.findUniqueOrThrow({ where: { id: uncertainOld.replaced_by_token_id } });
  assert.equal(uncertainNew.revoked_at, null, 'response loss did not trigger refresh family reuse revocation');

  const queueFiles = await fs.readdir(temp);
  for (const name of queueFiles) {
    const data = await fs.readFile(path.join(temp, name));
    for (const value of [auth.access_token, auth.refresh_token, auth2.access_token, auth2.refresh_token]) {
      assert.ok(!data.includes(Buffer.from(value)), 'credentials must not appear in the persistent outbox');
    }
  }
  console.log(JSON.stringify({
    result: 'AI-3 delivery passed',
    session_id: session.session_id, report_id: report.report_id,
    stored_scores: rows.map(value => value.focus_score), avg_focus_score: report.summary_json.avg_focus_score,
    offline_retries: 8, lost_ack_replayed: true, refresh_rotated: true,
    transient_refresh_recovered: true, conflict_end_blocked: true, refresh_family_revoked: true,
    lost_end_ack_recovered: true, ambiguous_refresh_requires_reauthentication: true,
    preserved_measurement_times: true, credentials_absent_from_outbox: true,
  }, null, 2));
}

async function main() {
  configureEnvironment();
  const app = require('../app');
  const db = require('../src/models/prismaClient');
  const { redis } = require('../src/services/redis');
  const server = http.createServer(app);
  const faults = {};
  const evidence = {
    log_payloads: [], log_statuses: [], refresh_statuses: [], end_requests: 0,
    refresh_requests: 0, lost_log_ack: 0, lost_end_ack: 0, lost_refresh_ack: 0,
    rate_limited: 0, refresh_unavailable: 0,
  };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'focuslens-ai3-'));
  let proxyServer;
  try {
    const base = await listen(server);
    proxyServer = faultProxy(base, faults, evidence);
    const proxy = await listen(proxyServer);
    await verify(base, proxy, db, temp, faults, evidence);
  } finally {
    if (proxyServer?.listening) await new Promise(resolve => proxyServer.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    redis.disconnect();
    await db.$disconnect();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`AI-3 verification failed: ${error.message}`);
  process.exitCode = 1;
});
