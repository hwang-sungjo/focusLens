// Browser evidence for a real session/report, public sharing and independent field masking.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { signUpAndLogin } = require('./fe2-auth.cjs');

// Replay the first LBE-4 camera minute's aggregate on a new, disposable session.
const scored = { gaze: 97.44, blink: 100, head: 100, total: 99.23, face_detected: true };
const absent = { gaze: 0, blink: 0, head: 0, total: 0, face_detected: false };

async function post(apiOrigin, path, body, token, status = 200) {
  const response = await fetch(apiOrigin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, 'Fixture API POST ' + path);
  const result = await response.json();
  assert.equal(result.success, true, path);
  return result.data;
}

async function prepareActor(context, origin, apiOrigin) {
  const actor = await signUpAndLogin(context, origin, apiOrigin);
  const token = await actor.page.evaluate(() => localStorage.getItem('access_token'));
  const session = await post(apiOrigin, '/api/sessions/start', {}, token, 201);
  return { ...actor, session, token };
}

async function endScoredMinute(apiOrigin, actor, fixture) {
  const { session_id: id, started_at: started } = actor.session;
  const boundary = new Date(started).getTime() + 60_000;
  await delay(Math.max(0, boundary + 150 - Date.now()));
  const log = await post(apiOrigin, '/api/v2/sessions/' + id + '/log', {
    ...fixture, measured_at: new Date(boundary).toISOString(), client_log_id: randomUUID(),
  }, actor.token);
  assert.equal(log.focus_score, fixture.total);
  assert.equal(log.minute_index, 1);
  const ended = await post(apiOrigin, '/api/sessions/' + id + '/end', {}, actor.token);
  assert.equal(ended.summary.avg_focus_score, fixture.total);
  assert.ok(ended.summary.duration_seconds >= 60);
  return ended.summary.duration_seconds;
}

async function setPrivacy(page, origin, scoreScope, timeScope, shareScope = 'PUBLIC') {
  await page.goto(origin + '/profile');
  for (const [label, value] of [
    ['기본 세션 공개 범위', shareScope], ['점수 공개 범위', scoreScope], ['학습 시간 공개 범위', timeScope],
  ]) {
    await page.getByText(label, { exact: true }).locator('xpath=following-sibling::select').selectOption(value);
  }
  await page.getByRole('checkbox', { name: '랭킹 참여' }).check();
  await page.getByRole('button', { name: '저장하기' }).click();
  await page.getByText('설정이 저장되었습니다.', { exact: true }).waitFor();
}

async function showReport(actor, origin, expectedScore) {
  const { page } = actor;
  await page.goto(origin + '/dashboard');
  await page.getByText(expectedScore.toFixed(1) + '점', { exact: true }).waitFor();
  await page.goto(origin + '/reports');
  const detail = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/reports/' + actor.session.session_id && response.status() === 200);
  const [response] = await Promise.all([detail,
    page.getByRole('button', { name: new RegExp('· ' + expectedScore.toFixed(0) + '점$') }).click(),
  ]);
  const report = (await response.json()).data;
  assert.equal(report.summary_json.avg_focus_score, expectedScore);
  assert.equal(report.timeline.length, 1);
  assert.equal(report.timeline[0].focus_score, expectedScore);
  await page.getByText(expectedScore.toFixed(1) + '점', { exact: true }).waitFor();
}

async function readFeed(viewer, origin, sessionId, note) {
  const page = viewer.page;
  const response = page.waitForResponse(r =>
    new URL(r.url()).pathname === '/api/session-shares/feed' && r.status() === 200);
  const [feed] = await Promise.all([response, page.goto(origin + '/feed')]);
  const { data } = await feed.json();
  const entry = data.feed.find(row => row.session_id === sessionId);
  const card = page.getByRole('article').filter({ hasText: note });
  return { entry, card };
}

async function checkFeed(viewer, origin, sessionId, note, score, seconds) {
  const { entry, card } = await readFeed(viewer, origin, sessionId, note);
  assert.ok(entry, 'Public session remains in the second account feed');
  assert.equal(entry.session_summary.avg_focus_score, score);
  assert.equal(entry.session_summary.duration_seconds, seconds);
  const metric = label => card.getByText(label, { exact: true }).locator('xpath=following-sibling::p');
  await metric('평균 집중도').waitFor();
  assert.equal(await metric('평균 집중도').innerText(), score === null ? '비공개' : score.toFixed(1) + '점');
  assert.equal(await metric('학습 시간').innerText(), seconds === null ? '비공개' : Math.floor(seconds / 60) + '분');
  return card;
}

async function verifyPrivacy({ browser, origin, apiOrigin }) {
  const ownerContext = await browser.newContext();
  let viewerContext;
  try {
    viewerContext = await browser.newContext();
    const [owner, viewer] = await Promise.all([
      prepareActor(ownerContext, origin, apiOrigin), prepareActor(viewerContext, origin, apiOrigin),
    ]);
    await setPrivacy(owner.page, origin, 'PUBLIC', 'PUBLIC');
    const [seconds] = await Promise.all([
      endScoredMinute(apiOrigin, owner, scored), endScoredMinute(apiOrigin, viewer, absent),
    ]);
    await Promise.all([showReport(owner, origin, scored.total), showReport(viewer, origin, absent.total)]);

    await owner.page.getByRole('button', { name: /공유하기/ }).click();
    const dialog = owner.page.getByRole('dialog', { name: '세션 공유하기' });
    await dialog.getByRole('radio', { name: '전체 공개' }).check();
    const note = 'FE-2 scored minute ' + randomUUID().slice(0, 8);
    await dialog.getByLabel('한마디 (선택)').fill(note);
    await dialog.getByRole('button', { name: '공유하기', exact: true }).click();
    await dialog.getByText('공유했어요. 피드에서 확인할 수 있어요.').waitFor();

    const sessionId = owner.session.session_id;
    const publicCard = await checkFeed(viewer, origin, sessionId, note, scored.total, seconds);

    await publicCard.getByRole('button', { name: '+ 친구', exact: true }).click();
    await publicCard.getByText('요청 보냄', { exact: true }).waitFor();
    await owner.page.goto(origin + '/friends');
    await owner.page.getByRole('listitem').filter({ hasText: viewer.nickname }).getByRole('button', { name: '수락' }).click();
    // Wait for the acceptance to be persisted before the sender opens the friends list.
    await owner.page.getByText(/내 친구.*1/u).waitFor();
    await viewer.page.goto(origin + '/friends');
    await viewer.page.getByText(/내 친구.*1/u).waitFor();
    await viewer.page.getByText(owner.nickname, { exact: true }).waitFor();
    await viewer.page.goto(origin + '/rankings');
    await viewer.page.getByRole('listitem').filter({ hasText: owner.nickname })
      .getByText(scored.total.toFixed(1) + '점', { exact: true }).waitFor();

    await setPrivacy(owner.page, origin, 'PRIVATE', 'PUBLIC');
    await checkFeed(viewer, origin, sessionId, note, null, seconds);
    await setPrivacy(owner.page, origin, 'PUBLIC', 'PRIVATE');
    await checkFeed(viewer, origin, sessionId, note, scored.total, null);
    await setPrivacy(owner.page, origin, 'PRIVATE', 'PRIVATE', 'PRIVATE');
    const removed = await readFeed(viewer, origin, sessionId, note);
    assert.equal(removed.entry, undefined);
    await viewer.page.getByText('불러오는 중...', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await removed.card.count(), 0);
    return {
      score_fixture: 'LBE-4 first camera minute aggregate replay', recorded_score: scored.total, absence_score: 0,
      nonzero_and_zero_dashboard_reports: true, public_share: true, independent_score_time_masks: true,
      private_share_removed: true, friend_request_accepted: true, ranked_score_visible: true,
    };
  } finally {
    await Promise.all([ownerContext.close(), viewerContext?.close()]);
  }
}

module.exports = { verifyPrivacy };
