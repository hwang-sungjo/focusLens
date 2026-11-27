const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { signUpAndLogin } = require('./fe2-auth.cjs');
const { defaultAiPython } = require('../local-ai-python');

async function startCompanion(mode, recoveryProxyOrigin) {
  const python = process.env.FOCUSLENS_AI_PYTHON || process.env.AI3_PYTHON || defaultAiPython();
  const file = path.resolve(__dirname, '../fe3_verify_bridge.py');
  const args = ['-B', file, mode];
  const env = { ...process.env };
  if (recoveryProxyOrigin) {
    env.LOCAL_VERIFY_URL = recoveryProxyOrigin;
    args.push('--recovery');
  }
  const child = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = readline.createInterface({ input: child.stdout });
  async function stop() {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { return await closed; }
    finally { clearTimeout(deadline); lines.close(); }
  }
  let deadline;
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Python companion unavailable')));
      child.once('close', () => reject(new Error('Python companion exited before startup')));
      deadline = setTimeout(() => reject(new Error('Python companion startup timed out')), 30_000);
      lines.once('line', line => {
        try { resolve(JSON.parse(line).port); } catch (_) { reject(new Error('Invalid companion startup')); }
      });
    });
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    return { origin: 'http://127.0.0.1:' + port, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally { clearTimeout(deadline); }
}

async function checkQueue(temporary, measurement) {
  const evidence = JSON.parse(await fs.readFile(path.join(temporary, 'fe3-queue.json'), 'utf8'));
  const { session_id, measured_at, client_log_id, score } = measurement;
  assert.deepEqual(evidence.logs, [{ session_id, measured_at, client_log_id, score, status: 'sent' }]);
  assert.deepEqual(evidence.delivery_sessions, [{ session_id, status: 'ended' }]);
}

function bridgeResponse(page, bridgeOrigin, route, action) {
  return Promise.all([
    page.waitForResponse(response => response.url() === bridgeOrigin + route
      && response.request().method() !== 'OPTIONS' && response.ok()),
    action(),
  ]).then(([response]) => response.json()).then(json => json.data);
}

async function waitForCapture(page, bridgeOrigin, ready, timeout) {
  const response = await page.waitForResponse(async item => {
    if (item.url() !== bridgeOrigin + '/status' || item.request().method() !== 'GET' || !item.ok()) return false;
    const { data } = await item.json();
    return data.phase === 'paused' || ready(data);
  }, { timeout });
  const { data } = await response.json();
  if (data.phase === 'paused') {
    const error = new Error('The AI capture paused');
    error.capture = { phase: 'paused', reason: data.error || 'camera_paused' };
    throw error;
  }
  return data;
}

async function checkMinuteDisplay(page, latest) {
  const stateName = { FOCUSED: '집중 상태', NORMAL: '보통', DISTRACTED: '집중 이탈' }[latest.attention_state];
  assert.ok(stateName);
  await page.getByText(stateName, { exact: true }).waitFor();
  const scorePanel = page.getByText('집중도', { exact: true }).locator('xpath=following-sibling::div[1]');
  await scorePanel.getByText(latest.focus_score.toFixed(0), { exact: true }).waitFor();
  for (const name of ['Gaze', 'Blink', 'Head']) {
    const value = page.getByText(name, { exact: true }).locator('xpath=following-sibling::span');
    assert.equal(await value.innerText(), latest[name.toLowerCase()].toFixed(0));
  }
}

async function verifyMeasurement({ browser, origin, apiOrigin, bridgeOrigin, mode, temporary }) {
  const context = await browser.newContext();
  const observerContext = await browser.newContext();
  try {
    const [{ page }, observer] = await Promise.all([context, observerContext].map(
      item => signUpAndLogin(item, origin, apiOrigin)));
    const directSessionWrites = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === apiOrigin && request.method() === 'POST' && /^\/api\/(?:v2\/)?sessions\b/.test(url.pathname)) {
        directSessionWrites.push(url.pathname);
      }
    });
    const button = name => page.getByRole('button', { name, exact: true });
    await page.goto(origin + '/session');
    await bridgeResponse(page, bridgeOrigin, '/start', () => button('세션 시작').click());
    if (mode === 'live') await waitForCapture(page, bridgeOrigin, data => data.preview_ready, 45_000);
    const preview = page.getByRole('img', { name: '웹캠 미리보기' });
    await preview.waitFor({ timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector('img[alt="웹캠 미리보기"]')?.naturalWidth > 0);
    await button('웹캠 숨기기').click();
    await preview.waitFor({ state: 'hidden' });
    await button('웹캠 보이기').click();
    await preview.waitFor();

    // A different account sees only its own local session and no frame.
    const other = await bridgeResponse(observer.page, bridgeOrigin, '/status',
      () => observer.page.goto(origin + '/session'));
    assert.equal(other.session_id, null);
    assert.equal(other.latest, null);
    const otherPreview = await observer.page.evaluate(async bridge => {
      const response = await fetch(bridge + '/preview', { credentials: 'omit',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('access_token') } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }, bridgeOrigin);
    assert.deepEqual(otherPreview, { status: 204, bytes: 0 });

    const before = await bridgeResponse(page, bridgeOrigin, '/status', () => page.reload());
    assert.ok(before.session_id && before.started_at);
    await button('세션 종료').waitFor();
    if (mode === 'fixture') {
      // The marker is visible only to the fixture camera in this private temp directory.
      await fs.writeFile(path.join(temporary, 'interrupt_fixture_camera'), '1', { flag: 'wx' });
      const resumed = await bridgeResponse(page, bridgeOrigin, '/resume', () => button('이어하기').click());
      assert.equal(resumed.session_id, before.session_id);
    }

    const { session_id, started_at, latest } = await waitForCapture(page, bridgeOrigin,
      data => Boolean(data.latest?.client_log_id), mode === 'live' ? 150_000 : 95_000);
    assert.equal(session_id, before.session_id);
    assert.equal(started_at, before.started_at);
    assert.ok(Date.parse(latest.measured_at) >= Date.parse(started_at) + 60_000);
    if (mode === 'fixture') assert.deepEqual(
      [latest.focus_score, latest.gaze, latest.blink, latest.head, latest.attention_state],
      [70, 0, 100, 100, 'FOCUSED']);
    await checkMinuteDisplay(page, latest);

    await bridgeResponse(page, bridgeOrigin, '/finish', () => button('세션 종료').click());
    await page.getByText('세션이 종료되었습니다. 수고하셨어요!', { exact: true }).waitFor();
    await page.goto(origin + '/reports');
    const [reportResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === apiOrigin + '/api/reports/' + session_id && response.ok()),
      page.getByRole('button', { name: new RegExp('· ' + latest.focus_score.toFixed(0) + '점$') }).click(),
    ]);
    const report = (await reportResponse.json()).data;
    assert.equal(report.summary_json.avg_focus_score, latest.focus_score);
    assert.equal(report.timeline.length, 1);
    assert.equal(report.timeline[0].focus_score, latest.focus_score);
    await page.getByText(latest.focus_score.toFixed(1) + '점', { exact: true }).waitFor();
    assert.equal(directSessionWrites.length, 0, 'Only the Python runtime writes session data');
    return {
      source: mode === 'live' ? 'physical camera' : 'synthetic camera features sampled in real time',
      session_id, report_id: report.report_id, measured_at: latest.measured_at,
      client_log_id: latest.client_log_id, score: latest.focus_score, attention_state: latest.attention_state,
      preview_toggle: true, isolated_account: true, reload_same_session: true,
      resumed_after_camera_interruption: mode === 'fixture', browser_session_writes: 0,
    };
  } finally {
    await Promise.all([context.close(), observerContext.close()]);
  }
}

module.exports = { startCompanion, checkQueue, verifyMeasurement, bridgeResponse, waitForCapture, checkMinuteDisplay };
