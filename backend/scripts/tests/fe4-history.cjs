const assert = require('node:assert/strict');

const count = 23;
const indices = Array.from({ length: count }, (_, offset) => count - offset);
const sessionPrefix = '00000001-0000-4000-8000-';
const sharePrefix = '00000002-0000-4000-8000-';
const fixtureId = (prefix, i) => prefix + String(i).padStart(12, '0');
const score = i => 72 + i;
const note = i => 'FE4 history ' + i;

// Seed only after the handoff wrapper has created and seeded its disposable Compose project.
async function prepareHistory({ project, sql, composeRun }) {
  assert.match(project, /^focuslens-handoff-[0-9a-f-]{36}$/);
  assert.equal(Number(await sql('SELECT count(*) FROM sessions')), 0, 'History requires a fresh database');
  await sql(`
    BEGIN;
    CREATE TEMP TABLE fe4_history ON COMMIT DROP AS
      SELECT i, '${sessionPrefix}' || lpad(i::text, 12, '0') AS session_id,
        '${sharePrefix}' || lpad(i::text, 12, '0') AS share_id, 72 + i AS score,
        date_trunc('day', now() AT TIME ZONE 'UTC')
          - interval '1 day' * CASE i WHEN 1 THEN 400 WHEN 2 THEN 120 WHEN 3 THEN 45 ELSE 24 - i END
          + interval '6 hours' AS started_at
      FROM generate_series(1, ${count}) AS i;
    UPDATE user_privacy_settings SET default_session_scope = 'FRIENDS', updated_at = now()
      WHERE user_id = (SELECT id FROM users WHERE email = 'user_a@focuslens.dev');
    INSERT INTO sessions (id, user_id, started_at, ended_at, status, created_at, updated_at)
      SELECT session_id, (SELECT id FROM users WHERE email = 'user_a@focuslens.dev'),
        started_at, started_at + interval '2 minutes', 'COMPLETED', started_at, started_at + interval '2 minutes'
      FROM fe4_history;
    INSERT INTO concentration_logs (id, session_id, minute_index, logged_at, gaze_score, blink_score,
      head_score, focus_score, attention_state, face_detected, updated_at)
      SELECT gen_random_uuid()::text, session_id, minute, started_at + minute * interval '1 minute',
        score + delta, score + delta, score + delta, score + delta, 'FOCUSED', true, now()
      FROM fe4_history CROSS JOIN (VALUES (1, -2), (2, 2)) AS sample(minute, delta);
    INSERT INTO reports (id, session_id, summary_json, updated_at)
      SELECT gen_random_uuid()::text, session_id, jsonb_build_object(
        'avg_focus_score', score, 'duration_seconds', 120, 'gaze_avg', score, 'blink_avg', score,
        'head_avg', score, 'focused_minutes', 2, 'normal_minutes', 0, 'distracted_minutes', 0,
        'total_logs', 2), now() FROM fe4_history;
    INSERT INTO session_shares (id, session_id, share_scope, share_message, created_at, updated_at)
      SELECT share_id, session_id, 'FRIENDS', 'FE4 history ' || i,
        -- Shares 3 and 4 have the same creation time on opposite sides of the page boundary.
        CASE WHEN i = 3 THEN (SELECT started_at FROM fe4_history WHERE i = 4)
          ELSE started_at END + interval '2 minutes', now()
      FROM fe4_history;
    COMMIT;`);
  // The development Prisma client prints SQL to stdout. Keep this one-shot job's output JSON-only.
  const output = await composeRun(['exec', '-T', '-e', 'NODE_ENV=test', 'backend', 'node', 'scripts/rollup.js'],
    'Roll up isolated history');
  let stages;
  try {
    ({ stages } = JSON.parse(output));
  } catch {
    throw new Error('Expected a JSON summary from the isolated Roll-up job');
  }
  assert.deepEqual(stages.map(row => [row.stage, row.deleted_rows, row.bucket_count]), [
    ['hourly', 6, 3], ['daily', 2, 2], ['weekly', 1, 1],
  ]);
}

async function readOn(page, url, action) {
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url() === url && res.request().method() === 'GET'),
    action(),
  ]);
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.equal(result.success, true);
  return result.data;
}

async function login(page, origin, actor) {
  await page.goto(origin + '/login');
  await page.locator('input[type=email]').fill('user_' + actor + '@focuslens.dev');
  await page.locator('input[type=password]').fill('password_' + actor + '123!');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByText('주간 평균 집중도', { exact: true }).waitFor();
}

async function verifyPages({ page, url, open, field, rows, checkLabels }) {
  const more = page.getByRole('button', { name: /^더 보기/ });
  for (const number of [1, 2]) {
    const data = await readOn(page, url + '&page=' + number + '&limit=20',
      number === 1 ? open : () => more.click());
    const end = Math.min(number * 20, count);
    const expected = indices.slice((number - 1) * 20, end);
    assert.deepEqual(data.pagination, { page: number, limit: 20, total: count });
    assert.deepEqual(data[field].map(row => row.session_id), expected.map(i => fixtureId(sessionPrefix, i)));
    if (field === 'feed') {
      assert.deepEqual(data.feed.map(row => row.share_id), expected.map(i => fixtureId(sharePrefix, i)));
    }
    if (number === 1) {
      await page.getByRole('button', { name: '더 보기 (20/23)', exact: true }).waitFor();
    } else {
      await more.waitFor({ state: 'hidden' });
    }
    await rows.nth(end - 1).waitFor();
    checkLabels(await rows.allInnerTexts(), indices.slice(0, end));
  }
}

async function verifyHistory({ browser, origin, apiOrigin }) {
  const owner = await browser.newContext();
  const friend = await browser.newContext();
  try {
    const page = await owner.newPage();
    await login(page, origin, 'a');
    const reportRows = page.getByText('완료된 세션', { exact: true }).locator('..').getByRole('listitem').getByRole('button');
    await verifyPages({
      page, url: apiOrigin + '/api/sessions?status=COMPLETED',
      open: () => page.getByRole('link', { name: '리포트', exact: true }).click(),
      field: 'sessions', rows: reportRows,
      checkLabels: (labels, expected) => assert.deepEqual(labels.map(s => s.split(' · ').at(-1)),
        expected.map(i => score(i) + '점')),
    });
    for (const [i, unit, label] of [[3, 'HOUR', '1시간'], [2, 'DAY', '1일'], [1, 'WEEK', '1주']]) {
      const id = fixtureId(sessionPrefix, i);
      const report = await readOn(page, apiOrigin + '/api/reports/' + id,
        () => page.getByRole('button', { name: new RegExp('· ' + score(i) + '점$') }).click());
      assert.equal(report.session_id, id);
      assert.equal(report.timeline.length, 1);
      const [bucket] = report.timeline;
      assert.deepEqual([bucket.granularity, bucket.log_count, bucket.focused_count, bucket.focus_score],
        [unit, 2, 2, score(i)]);
      assert.equal(report.summary_json.avg_focus_score, score(i));
      await page.getByText(new RegExp(label + ' 평균으로 저장')).waitFor();
      await page.getByText(score(i).toFixed(1) + '점', { exact: true }).waitFor();
      await page.locator('canvas').waitFor();
      assert.equal(await page.getByText(/TOP 구간/).count(), 0);
    }

    const feed = await friend.newPage();
    await login(feed, origin, 'b');
    await readOn(feed, apiOrigin + '/api/session-shares/feed?scope=all&page=1&limit=20',
      () => feed.getByRole('link', { name: '피드', exact: true }).click());
    const articles = feed.getByRole('article');
    await articles.first().waitFor();
    await verifyPages({
      page: feed, url: apiOrigin + '/api/session-shares/feed?scope=friends',
      open: () => feed.getByRole('button', { name: '친구', exact: true }).click(),
      field: 'feed', rows: articles,
      checkLabels: (labels, expected) => assert.deepEqual(labels.map(s => s.match(/^FE4 history \d+$/m)?.[0]),
        expected.map(note)),
    });
    return { report_pages: [20, 3], friend_feed_pages: [20, 3], distinct_sessions: count,
      distinct_shares: count, report_timeline_units: ['HOUR', 'DAY', 'WEEK'] };
  } finally {
    await Promise.all([owner.close(), friend.close()]);
  }
}

module.exports = { prepareHistory, verifyHistory };
