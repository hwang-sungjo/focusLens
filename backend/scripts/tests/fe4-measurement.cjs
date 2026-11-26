const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { faultProxy, listen } = require('../verify-ai3-delivery');
const { signUpAndLogin } = require('./fe2-auth.cjs');
const { bridgeResponse, waitForCapture, checkMinuteDisplay } = require('./fe3-measurement.cjs');

async function startRecoveryProxy(apiOrigin) {
  assert.equal(apiOrigin, process.env.LOCAL_VERIFY_URL);
  assert.match(apiOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(process.env.COMPOSE_PROJECT_NAME || '', /^focuslens-handoff-[a-f0-9-]{36}$/);
  const faults = { offline: true };
  const evidence = { log_payloads: [], log_statuses: [], lost_log_ack: 0, end_requests: 0,
    refresh_requests: 0, refresh_statuses: [] };
  const server = faultProxy(apiOrigin, faults, evidence);
  const origin = await listen(server);
  return {
    origin, evidence,
    restore() {
      faults.dropLogOnce = true;
      faults.offline = false;
    },
    stop() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

// These fields are the complete v2 request, as observed by the UI before reconnecting.
function logPayload({ client_log_id, measured_at, gaze, blink, head, score, face_detected }) {
  return { client_log_id, measured_at, gaze, blink, head, total: score, face_detected };
}

async function checkRecoveryQueue(temporary, { session_id, minutes }) {
  const stored = JSON.parse(await fs.readFile(path.join(temporary, 'fe3-queue.json'), 'utf8'));
  assert.deepEqual(stored.delivery_sessions, [{ session_id, status: 'ended' }]);
  assert.deepEqual(stored.logs, minutes.map(minute => ({
    session_id, status: 'sent', client_log_id: minute.client_log_id, measured_at: minute.measured_at,
    score: minute.score, payload: logPayload(minute),
  })));
}

async function readApi(page, apiOrigin, route, expectedStatus = 200) {
  const result = await page.evaluate(async url => {
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('access_token') },
    });
    return { status: response.status, body: await response.json() };
  }, apiOrigin + route);
  assert.equal(result.status, expectedStatus);
  assert.equal(result.body.success, expectedStatus === 200);
  return result.body.data;
}

async function verifyRecovery({ browser, origin, apiOrigin, bridgeOrigin, mode, proxy }) {
  const context = await browser.newContext();
  let directWrites = 0;
  context.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
        && /^\/api\/(?:v2\/)?sessions\b/.test(new URL(request.url()).pathname)) directWrites++;
  });
  try {
    const { page } = await signUpAndLogin(context, origin, apiOrigin);
    // Two distracted physical-camera minutes can show the ordinary rest prompt over the finish button.
    const restPrompt = page.getByRole('dialog').filter({ hasText: '잠깐 쉬어 갈까요?' });
    await page.addLocatorHandler(restPrompt, dialog => dialog.getByRole('button', { name: '확인' }).click());
    const { evidence } = proxy;
    const button = name => page.getByRole('button', { name, exact: true });
    const finish = name => bridgeResponse(page, bridgeOrigin, '/finish', () => button(name).click());
    const waitForPendingFinish = () => waitForCapture(page, bridgeOrigin,
      data => data.phase === 'closing' && data.error === 'pending_logs' && data.pending === 2, 30_000);
    await page.goto(origin + '/session');
    const { session_id, started_at } = await bridgeResponse(page, bridgeOrigin, '/start',
      () => button('세션 시작').click());
    const minutes = [];
    for (const pending of [1, 2]) {
      const status = await waitForCapture(page, bridgeOrigin,
        data => data.phase === 'measuring' && data.pending === pending && !!data.latest,
        mode === 'live' ? 150_000 : 95_000);
      assert.equal(status.session_id, session_id);
      assert.equal(status.started_at, started_at);
      assert.equal(status.failed, 0);
      const { focus_score: score, ...fields } = status.latest;
      minutes.push({ ...fields, score });
      if (pending === 2) await finish('세션 종료');
      await page.getByText('전송 대기 ' + pending + '건 · 전송 실패 0건', { exact: true }).waitFor();
      await checkMinuteDisplay(page, status.latest);
    }
    const [first, second] = minutes;
    assert.notEqual(first.client_log_id, second.client_log_id);
    assert.ok(Date.parse(first.measured_at) - Date.parse(started_at) >= 60_000);
    const interval_ms = Date.parse(second.measured_at) - Date.parse(first.measured_at);
    assert.equal(interval_ms, 60_000, 'Expected two consecutive complete minute windows');
    if (mode === 'fixture') {
      assert.deepEqual(minutes.map(m => [m.score, m.face_detected]), [[70, true], [0, false]]);
    }

    await waitForPendingFinish();
    await page.getByText(/전송을 기다리는 기록이 있습니다/).waitFor();
    const sessionPath = '/api/sessions/' + session_id;
    const reportPath = '/api/reports/' + session_id;
    const offline = await readApi(page, apiOrigin, sessionPath);
    assert.equal(offline.status, 'IN_PROGRESS');
    assert.deepEqual(offline.timeline, []);
    await readApi(page, apiOrigin, reportPath, 404);
    assert.equal(evidence.end_requests, 0);
    assert.deepEqual(evidence.log_statuses, []);
    const blockedAttempts = evidence.log_payloads.length;
    assert.ok(blockedAttempts > 0, 'The delivery worker must hit the isolated outage');
    for (const attempted of evidence.log_payloads) assert.deepEqual(attempted, logPayload(first));

    // The first retry commits one row but drops its HTTP response. The outbox must retain both.
    proxy.restore();
    await finish('종료하기');
    await waitForPendingFinish();
    const unacknowledged = await readApi(page, apiOrigin, sessionPath);
    assert.equal(unacknowledged.status, 'IN_PROGRESS');
    assert.equal(unacknowledged.timeline.length, 1);
    assert.equal(unacknowledged.timeline[0].focus_score, first.score);
    assert.equal(evidence.end_requests, 0);
    assert.equal(evidence.lost_log_ack, 1);
    assert.deepEqual(evidence.log_statuses, [200]);

    await finish('종료하기');
    await page.getByText('세션이 종료되었습니다. 수고하셨어요!', { exact: true }).waitFor();
    assert.deepEqual(evidence.log_statuses, [200, 200, 200]);
    assert.equal(evidence.end_requests, 1);
    assert.deepEqual(evidence.log_payloads.slice(blockedAttempts),
      [logPayload(first), logPayload(first), logPayload(second)]);

    const [listResponse] = await Promise.all([
      page.waitForResponse(response => response.url().startsWith(apiOrigin + '/api/sessions?status=COMPLETED&')
        && response.request().method() === 'GET' && response.ok()),
      page.goto(origin + '/reports'),
    ]);
    const list = (await listResponse.json()).data;
    assert.equal(list.pagination.total, 1);
    assert.deepEqual(list.sessions.map(item => [item.session_id, item.status]), [[session_id, 'COMPLETED']]);
    const listLabel = new RegExp('· ' + list.sessions[0].avg_focus_score.toFixed(0) + '점$');
    const [detail] = await Promise.all([
      page.waitForResponse(response => response.url() === apiOrigin + reportPath && response.ok()),
      page.getByRole('button', { name: listLabel }).click(),
    ]);
    const report = (await detail.json()).data;
    const avg_focus_score = Math.round(((first.score + second.score) / 2) * 100) / 100;
    assert.equal(report.session_id, session_id);
    assert.equal(report.summary_json.total_logs, 2);
    assert.equal(report.summary_json.avg_focus_score, avg_focus_score);
    assert.equal(report.timeline.length, 2);
    const timeline = [...report.timeline].sort((a, b) => a.minute_index - b.minute_index);
    for (const [i, minute] of minutes.entries()) {
      const row = timeline[i];
      const index = Math.floor((Date.parse(minute.measured_at) - Date.parse(started_at)) / 60_000);
      assert.deepEqual([row.granularity, row.minute_index, row.log_count, row.gaze_score, row.blink_score,
        row.head_score, row.focus_score, row.attention_state, row.face_detected],
      ['MINUTE', index, 1, minute.gaze, minute.blink, minute.head, minute.score, minute.attention_state, minute.face_detected]);
    }
    await page.getByText(avg_focus_score.toFixed(1) + '점', { exact: true }).waitFor();
    assert.equal(directWrites, 0);
    return {
      source: mode === 'live' ? 'physical camera' : 'synthetic camera features sampled in real time',
      session_id, report_id: report.report_id, minutes, interval_ms, avg_focus_score,
      pending_before_reconnect: 2, offline_attempts: blockedAttempts, offline_backend_logs: offline.timeline.length,
      blocked_finish_verified: true, committed_before_ack: unacknowledged.timeline.length,
      lost_log_ack: evidence.lost_log_ack, original_payloads_replayed: true, backend_end_requests: evidence.end_requests,
      report_timeline_minutes: report.timeline.length, browser_session_writes: directWrites,
    };
  } finally {
    await context.close();
  }
}

module.exports = { startRecoveryProxy, verifyRecovery, checkRecoveryQueue };
