// AI-1: exercise the real Express API and inspect the disposable PostgreSQL rows.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');

function configureEnvironment() {
  for (const key of ['AI1_DATABASE_URL', 'AI1_REDIS_URL']) {
    assert.ok(process.env[key], `Missing ${key}. Start the isolated AI-1 runner.`);
    const url = new URL(process.env[key]);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port,
      `${key} must use a dedicated local service with an explicit port.`);
    if (key === 'AI1_DATABASE_URL') {
      assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && /^\/focuslens_ai1(?:_\w+)?$/.test(url.pathname),
        'Expected a disposable focuslens_ai1 database.');
    } else {
      assert.equal(url.protocol, 'redis:');
    }
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.AI1_DATABASE_URL,
    REDIS_URL: process.env.AI1_REDIS_URL,
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_EXPIRES_IN: '1h',
  });
}

function checkFields(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${label}.${key}`);
  }
}

async function verify(baseUrl, db) {
  let token;
  async function request(method, path, status, body) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const label = `${method} ${path} (request ID: ${response.headers.get('x-request-id')})`;
    assert.equal(response.status, status, label);
    const envelope = await response.json();
    assert.equal(envelope.success, true, label);
    return envelope.data;
  }

  checkFields(await request('GET', '/health', 200), { db: 'connected', redis: 'connected' }, 'health');
  const id = randomUUID();
  const credentials = { email: `ai1-${id}@example.test`, password: randomBytes(18).toString('hex') };
  const user = await request('POST', '/api/auth/register', 201, {
    ...credentials, name: 'AI-1', nickname: `ai1-${id.slice(0, 16)}`,
  });
  const login = await request('POST', '/api/auth/login', 200, credentials);
  assert.equal(login.user_id, user.user_id, 'login user');
  assert.ok(login.access_token, 'missing login access token');
  token = login.access_token;
  const session = await request('POST', '/api/sessions/start', 201, {});
  assert.equal(session.status, 'IN_PROGRESS');
  const sessionId = session.session_id;

  // Model two already elapsed minutes on this fixture session. Log writes, session
  // termination, and report generation all go through the real HTTP handlers.
  const start = Date.parse(session.started_at) - 125_000;
  const adjusted = await db.sessions.updateMany({
    where: { id: sessionId, user_id: user.user_id, status: 'IN_PROGRESS' },
    data: { started_at: new Date(start) },
  });
  assert.equal(adjusted.count, 1, 'fixture session setup');
  const samples = [
    { gaze: 85.5, blink: 72, head: 90, total: 79.65, face_detected: true },
    { gaze: 0, blink: 0, head: 0, total: 0, face_detected: false },
  ];
  const expectedStates = ['FOCUSED', 'DISTRACTED'];
  const received = [];
  const path = `/api/v2/sessions/${sessionId}/log`;
  for (const [index, sample] of samples.entries()) {
    const minute = index + 1;
    const payload = {
      ...sample, client_log_id: randomUUID(), measured_at: new Date(start + minute * 60_000).toISOString(),
    };
    const log = await request('POST', path, 200, payload);
    checkFields(log, {
      client_log_id: payload.client_log_id, measured_at: payload.measured_at, minute_index: minute,
      focus_score: sample.total, face_detected: sample.face_detected, attention_state: expectedStates[index],
    }, `log response minute ${minute}`);
    received.push(log);
    const replay = await request('POST', path, 200, payload);
    assert.deepEqual(replay, log, `identical replay minute ${minute}`);
  }

  const rows = await db.concentration_logs.findMany({ where: { session_id: sessionId }, orderBy: { minute_index: 'asc' } });
  assert.equal(rows.length, 2, 'two distinct DB rows after replaying both payloads');
  const ended = await request('POST', `/api/sessions/${sessionId}/end`, 200, {});
  const report = await request('GET', `/api/reports/${sessionId}`, 200);
  const storedReport = await db.reports.findUniqueOrThrow({ where: { session_id: sessionId } });
  checkFields(ended, { status: 'COMPLETED', session_id: sessionId, report_id: storedReport.id }, 'session end');
  checkFields(report, { session_id: sessionId, report_id: storedReport.id }, 'report');
  checkFields(ended.summary, {
    avg_focus_score: 39.83, gaze_avg: 42.75, blink_avg: 36, head_avg: 45,
    focused_minutes: 1, normal_minutes: 0, distracted_minutes: 1, total_logs: 2,
  }, 'end summary');
  assert.deepEqual(report.summary_json, ended.summary, 'report matches end summary');
  assert.deepEqual(storedReport.summary_json, ended.summary, 'persisted report matches end summary');
  assert.equal(report.timeline.length, 2, 'report timeline length');
  for (const [index, row] of rows.entries()) {
    const sample = samples[index];
    const log = received[index];
    const expected = {
      minute_index: index + 1, gaze_score: sample.gaze, blink_score: sample.blink, head_score: sample.head,
      focus_score: sample.total, attention_state: expectedStates[index], face_detected: sample.face_detected,
    };
    checkFields(row, { ...expected, id: log.log_id, client_log_id: log.client_log_id }, 'DB log');
    assert.equal(row.measured_at.toISOString(), log.measured_at, 'DB measurement time');
    assert.equal(row.logged_at.toISOString(), log.logged_at, 'DB receipt time');
    const entry = report.timeline.find((point) => point.minute_index === expected.minute_index);
    assert.ok(entry, `missing timeline minute ${expected.minute_index}`);
    checkFields(entry, { ...expected, granularity: 'MINUTE', log_count: 1, logged_at: log.logged_at }, 'report timeline');
  }

  console.log(JSON.stringify({
    result: 'AI-1 passed', session_id: sessionId, report_id: report.report_id,
    api_scores: received.map((log) => log.focus_score), db_scores: rows.map((log) => log.focus_score),
    timeline_scores: report.timeline.map((point) => point.focus_score), total_logs: ended.summary.total_logs,
    avg_focus_score: ended.summary.avg_focus_score,
  }, null, 2));
}

async function main() {
  configureEnvironment();
  const app = require('../app');
  const db = require('../src/models/prismaClient');
  const { redis } = require('../src/services/redis');
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await verify(`http://127.0.0.1:${server.address().port}`, db);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    redis.disconnect();
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`AI-1 failed: ${error.message}`);
  process.exitCode = 1;
});
