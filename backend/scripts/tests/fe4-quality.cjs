// Browser checks against the production frontend and the disposable stack.
const assert = require('node:assert/strict');
const { signUpAndLogin } = require('./fe2-auth.cjs');

const button = (page, name) => page.getByRole('button', { name, exact: true });
const marker = '<script type="text/plain">독서</script> & 복습';
const phone = { width: 360, height: 800 };
const desktop = { width: 1280, height: 800 };

async function fitsViewport(page) {
  const layout = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = [...document.querySelectorAll('a[href], button, select, textarea, input, h1')].filter(el => {
      const box = el.getBoundingClientRect();
      return box.width && box.height && (box.left < -1 || box.right > width + 1);
    }).map(el => el.tagName.toLowerCase());
    return { width, scrollWidth: document.documentElement.scrollWidth, clipped };
  });
  const screen = new URL(page.url()).pathname.replace(/\/groups\/.+/, '/groups/:id') + ' at ' + layout.width;
  assert.equal(layout.width, page.viewportSize().width, screen + ' viewport meta');
  assert.ok(layout.scrollWidth <= layout.width + 1, screen + ' horizontal overflow');
  assert.deepEqual(layout.clipped, [], screen + ' controls outside viewport');
}

async function tabTo(page, locator) {
  // Exercise the real tab sequence. An element reachable only with programmatic focus must fail.
  for (let count = 0; count < 32; count++) {
    if (await locator.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('Control could not be reached by keyboard');
}

async function checkNavigation(page, origin) {
  const menu = button(page, '페이지 메뉴');
  const account = button(page, '계정 메뉴');
  const mobile = page.viewportSize().width === phone.width;
  await page.goto(origin + '/dashboard');
  const link = page.getByRole('navigation').getByRole('link', { name: '세션', exact: true });
  assert.equal(await menu.isVisible(), mobile);
  if (mobile) {
    assert.equal(await link.isVisible(), false);
    await tabTo(page, menu);
    await page.keyboard.press('Enter');
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await fitsViewport(page);
    await tabTo(page, account);
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('link', { name: '프로필 / 설정' }));
    await page.keyboard.press('Escape');
    assert.equal(await account.getAttribute('aria-expanded'), 'false');
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await tabTo(page, link);
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.ok(await menu.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Space');
  }
  await tabTo(page, link);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '학습 세션' }).waitFor();
  await tabTo(page, account);
  await page.keyboard.press('Enter');
  const profile = page.getByRole('link', { name: '프로필 / 설정' });
  await tabTo(page, profile);
  await page.keyboard.press('Escape');
  assert.equal(await account.getAttribute('aria-expanded'), 'false');
  assert.ok(await account.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  await tabTo(page, profile);
  await page.keyboard.press('Enter');
  await page.getByText('프라이버시 설정', { exact: true }).waitFor();
  for (const name of ['닉네임', '소개', '기본 세션 공개 범위', '점수 공개 범위', '학습 시간 공개 범위']) {
    await page.getByLabel(name, { exact: true }).waitFor();
  }
}

async function createGroup(owner, viewer, origin, apiOrigin) {
  const { page } = owner;
  const nickname = '<em>' + owner.userId.slice(0, 8) + '</em> & 읽기';
  await page.goto(origin + '/profile');
  await page.getByText('프라이버시 설정', { exact: true }).waitFor();
  await page.getByLabel('닉네임', { exact: true }).fill(nickname);
  await button(page, '저장하기').click();
  await page.getByText('설정이 저장되었습니다.', { exact: true }).waitFor();
  await page.goto(origin + '/groups');
  await button(page, '+ 새 그룹').click();
  await page.getByLabel('이름 (필수)').fill('FE4 읽기 모임');
  await page.getByLabel('소개 (선택)').fill(marker);
  await page.getByLabel('공개 여부').selectOption('PUBLIC');
  const [created] = await Promise.all([
    page.waitForResponse(r => r.url() === apiOrigin + '/api/groups' && r.request().method() === 'POST'),
    button(page, '만들기').click(),
  ]);
  assert.equal(created.status(), 201);
  const group = (await created.json()).data;
  assert.equal(group.description, marker);
  const path = '/groups/' + group.group_id;
  await page.waitForURL(origin + path);
  const memberName = page.getByRole('listitem').getByText(nickname);
  await memberName.waitFor();
  assert.equal(await memberName.evaluate(el => el.firstChild.textContent), nickname);
  assert.equal(await memberName.locator('em').count(), 0);
  const [response] = await Promise.all([
    viewer.page.waitForResponse(r => r.url() === apiOrigin + '/api' + path && r.request().method() === 'GET'),
    viewer.page.goto(origin + path),
  ]);
  assert.equal(response.status(), 200);
  const stored = (await response.json()).data;
  assert.equal(stored.my_role, null);
  assert.equal(stored.description, marker);
  for (const reader of [page, viewer.page]) {
    const literal = reader.getByText(marker, { exact: true });
    await literal.waitFor();
    assert.equal(await literal.textContent(), marker);
    assert.equal(await literal.locator('script').count(), 0);
  }
  return path;
}

async function prepareReport(owner, apiOrigin) {
  // This closed session only supplies a report trigger. It has no camera input or scores.
  const token = await owner.page.evaluate(() => localStorage.getItem('access_token'));
  const headers = { Authorization: 'Bearer ' + token };
  const api = owner.page.request;
  const started = await api.post(apiOrigin + '/api/sessions/start', { headers, data: {} });
  assert.equal(started.status(), 201);
  const id = (await started.json()).data.session_id;
  const ended = await api.post(apiOrigin + '/api/sessions/' + id + '/end', { headers, data: {} });
  assert.equal(ended.status(), 200);
}

async function checkReportDialog(page) {
  const entry = page.getByRole('listitem').getByRole('button');
  await tabTo(page, entry);
  await page.keyboard.press('Enter');
  const trigger = page.getByRole('button', { name: /공유하기/ });
  await trigger.waitFor();
  await fitsViewport(page);
  await tabTo(page, trigger);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '세션 공유하기' });
  const cancel = button(dialog, '취소');
  await cancel.waitFor();
  assert.ok(await dialog.evaluate(el => el.matches(':modal') && el.contains(document.activeElement)));
  await fitsViewport(page);
  await tabTo(page, cancel);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await trigger.evaluate(el => el === document.activeElement), 'Closing restores the share button focus');
}

async function verifyQuality({ browser, origin, apiOrigin }) {
  const ownerContext = await browser.newContext();
  let viewerContext;
  try {
    viewerContext = await browser.newContext();
    const [owner, viewer] = await Promise.all(
      [ownerContext, viewerContext].map(context => signUpAndLogin(context, origin, apiOrigin)),
    );
    const { page } = owner;
    const groupPath = await createGroup(owner, viewer, origin, apiOrigin);
    await prepareReport(owner, apiOrigin);
    const screens = [
      ['/login', '로그인하고 학습 집중도를 확인하세요'],
      ['/register', '회원가입하고 학습을 시작하세요'],
      ['/dashboard', '주간 평균 집중도'],
      ['/session', '경과 시간'],
      ['/reports', '완료된 세션'],
      ['/profile', '프라이버시 설정'],
      ['/feed', null],
      ['/rankings', '내 순위'],
      ['/friends', '아직 친구가 없어요.'],
      ['/groups', marker],
      [groupPath, '멤버 현황 1명'],
    ];
    for (const viewport of [phone, desktop]) {
      await page.setViewportSize(viewport);
      for (const [path, ready] of screens) {
        await page.goto(origin + path);
        if (ready) await page.getByText(ready, { exact: true }).waitFor();
        else await page.getByRole('article').first().or(page.getByText('아직 공유된 세션이 없어요.', { exact: true })).first().waitFor();
        await page.getByRole('heading', { level: 1 }).waitFor();
        if (path === '/login' || path === '/register') {
          const fields = path === '/register' ? ['이름', '닉네임', '이메일', '비밀번호'] : ['이메일', '비밀번호'];
          for (const field of fields) await tabTo(page, page.getByLabel(field, { exact: true }));
        }
        if (path === '/reports') await checkReportDialog(page);
        await fitsViewport(page);
      }
      await checkNavigation(page, origin);
    }
    return {
      viewport_px: [phone, desktop],
      routes_per_viewport: screens.length,
      keyboard: 'Tab, Enter, Space and Escape for navigation, account settings and modal share dialog; focus restored',
      stored_text: 'saved nickname rendered literally in group members; group description read literally by author and nonmember',
    };
  } finally {
    await Promise.all([ownerContext.close(), viewerContext?.close()]);
  }
}

module.exports = { verifyQuality };
