const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const cookieName = 'focuslens_refresh_token';

function responseFor(page, apiOrigin, path, method, status) {
  return page.waitForResponse(response => response.url() === new URL(path, apiOrigin).href
    && response.request().method() === method && response.status() === status);
}

async function signUpAndLogin(context, origin, apiOrigin) {
  const id = randomUUID();
  const email = `fe2-${id}@example.com`;
  const nickname = `FE2-${id.slice(0, 12)}`;
  const password = randomUUID();
  const page = await context.newPage();
  await page.goto(new URL('/register', origin).href);
  await page.getByPlaceholder('홍길동').fill('FE2');
  await page.getByPlaceholder('focus_master').fill(nickname);
  const fillCredentials = async () => {
    await page.locator('input[type=email]').fill(email);
    // Browser action errors can include their input. Keep generated passwords out of diagnostics.
    await page.locator('input[type=password]').fill(password).catch(() => {
      throw new Error('Could not enter the disposable account password');
    });
  };
  await fillCredentials();
  await Promise.all([
    responseFor(page, apiOrigin, '/api/auth/register', 'POST', 201),
    page.getByRole('button', { name: '회원가입', exact: true }).click(),
  ]);
  await page.getByText('회원가입이 완료되었습니다. 로그인해주세요.', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => localStorage.getItem('access_token') === null));
  await fillCredentials();
  await Promise.all([
    responseFor(page, apiOrigin, '/api/auth/login', 'POST', 200),
    responseFor(page, apiOrigin, '/api/reports/weekly', 'GET', 200),
    page.getByRole('button', { name: '로그인', exact: true }).click(),
  ]);
  await page.getByText('주간 평균 집중도', { exact: true }).waitFor();
  const userId = await page.evaluate(() => localStorage.getItem('user_id'));
  assert.ok(userId, 'A successful login should establish an identity');
  return { page, nickname, userId, email };
}

async function refreshCookie(context, apiOrigin) {
  const cookies = await context.cookies(new URL('/api/auth/refresh', apiOrigin).href);
  return cookies.find(cookie => cookie.name === cookieName);
}

async function forceAccessRejection(page) {
  // Trigger a real API 401 without changing server time, JWT lifetime or cookie contents.
  await page.evaluate(() => localStorage.setItem('access_token', 'fe2-invalid-access-token'));
}

async function enterProfile(page) {
  await page.getByRole('button', { name: '계정 메뉴', exact: true }).click();
  await page.getByRole('link', { name: '프로필 / 설정', exact: true }).click();
  await page.getByText('프라이버시 설정', { exact: true }).waitFor();
}

async function verifyAuth({ browser, origin, apiOrigin }) {
  const first = await browser.newContext();
  let second;
  try {
    second = await browser.newContext();
    const { page, userId, nickname } = await signUpAndLogin(first, origin, apiOrigin);
    const other = await signUpAndLogin(second, origin, apiOrigin);
    assert.notEqual(userId, other.userId);

    const initialCookie = await refreshCookie(first, apiOrigin);
    assert.ok(initialCookie?.value && initialCookie.httpOnly && initialCookie.sameSite === 'Lax');
    assert.equal(initialCookie.path, '/api/auth');
    assert.equal(initialCookie.domain, new URL(apiOrigin).hostname);
    await forceAccessRejection(page);
    const [, refreshed] = await Promise.all([
      responseFor(page, apiOrigin, '/api/reports/monthly', 'GET', 401),
      responseFor(page, apiOrigin, '/api/auth/refresh', 'POST', 200),
      responseFor(page, apiOrigin, '/api/reports/monthly', 'GET', 200),
      page.getByRole('button', { name: '월간', exact: true }).click(),
    ]);
    assert.ok(!refreshed.request().postData(), 'The browser should refresh using only its cookie');
    await page.getByText('월간 평균 집중도', { exact: true }).waitFor();
    const rotated = await refreshCookie(first, apiOrigin);
    assert.ok(rotated?.value && rotated.value !== initialCookie.value, 'Refresh cookie did not rotate');

    // Only this transient failure is injected. Unregister it before the real retry and logout.
    const refreshUrl = new URL('/api/auth/refresh', apiOrigin).href;
    await page.route(refreshUrl, route => route.fulfill({
      status: 503, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'X-Request-ID', 'X-Request-ID': 'fe2-injected-refresh-503' },
      body: JSON.stringify({ success: false, data: {}, error: '' }),
    }));
    await forceAccessRejection(page);
    await page.getByRole('button', { name: '주간', exact: true }).click();
    await page.getByText(/서비스가 일시적으로 불안정합니다.*fe2-injected-refresh-503/u).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('user_id')), userId);
    assert.ok(await page.evaluate(() => Boolean(localStorage.getItem('access_token'))));
    assert.ok((await refreshCookie(first, apiOrigin))?.value === rotated.value);
    await page.unroute(refreshUrl);
    await Promise.all([
      responseFor(page, apiOrigin, '/api/auth/refresh', 'POST', 200),
      responseFor(page, apiOrigin, '/api/reports/weekly', 'GET', 200),
      page.getByRole('button', { name: '다시 시도', exact: true }).click(),
    ]);
    await page.getByText('주간 평균 집중도', { exact: true }).waitFor();

    await first.grantPermissions([], { origin });
    const [activeSessions] = await Promise.all([
      responseFor(page, apiOrigin, '/api/sessions?status=IN_PROGRESS&limit=1', 'GET', 200),
      page.getByRole('link', { name: '세션', exact: true }).click(),
    ]);
    assert.equal((await activeSessions.json()).data.sessions.length, 0);
    await page.getByRole('button', { name: '세션 시작', exact: true }).waitFor();
    await page.getByText('00:00', { exact: true }).waitFor();

    await enterProfile(page);
    assert.equal(await page.locator('input[type=text]').inputValue(), nickname);
    const bio = 'FE-2 브라우저 프로필 저장 확인';
    await page.locator('textarea').fill(bio);
    await Promise.all([
      responseFor(page, apiOrigin, '/api/users/me/profile', 'PATCH', 200),
      responseFor(page, apiOrigin, '/api/users/me/privacy', 'PATCH', 200),
      page.getByRole('button', { name: '저장하기', exact: true }).click(),
    ]);
    await page.getByText('설정이 저장되었습니다.', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('프라이버시 설정', { exact: true }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), bio);

    await page.getByRole('button', { name: '계정 메뉴', exact: true }).click();
    await Promise.all([
      responseFor(page, apiOrigin, '/api/auth/logout', 'POST', 200),
      page.getByRole('button', { name: '로그아웃', exact: true }).click(),
    ]);
    await page.waitForURL(new URL('/login', origin).href);
    assert.ok(!await refreshCookie(first, apiOrigin), 'Logged-out browser cookie was not cleared');
    assert.ok(await page.evaluate(() => !localStorage.getItem('access_token') && !localStorage.getItem('user_id')));
    await page.goto(new URL('/profile', origin).href);
    await page.waitForURL(new URL('/login', origin).href);

    // The second viewer can still use their own cookie after the first user logged out.
    await forceAccessRejection(other.page);
    await Promise.all([
      responseFor(other.page, apiOrigin, '/api/auth/refresh', 'POST', 200),
      enterProfile(other.page),
    ]);
    assert.equal(await other.page.locator('input[type=text]').inputValue(), other.nickname);
    await second.clearCookies();
    await forceAccessRejection(other.page);
    await Promise.all([
      responseFor(other.page, apiOrigin, '/api/auth/refresh', 'POST', 401),
      other.page.goto(new URL('/dashboard', origin).href),
    ]);
    await other.page.waitForURL(new URL('/login?expired=true', origin).href);
    await other.page.getByText('로그인 시간이 만료되었습니다. 다시 로그인해주세요.', { exact: true }).waitFor();
    assert.ok(await other.page.evaluate(() => !localStorage.getItem('access_token') && !localStorage.getItem('user_id')));

    return {
      registered_browser_accounts: 2,
      dashboard: ['weekly', 'monthly'],
      session: 'empty active-session query and idle screen, camera permission not granted',
      profile_save_and_reload: true,
      refresh_cookie: '401 then cookie-only rotation and successful retry',
      injected_refresh_503: 'login retained, manual retry with real API successful',
      logout: 'cookie and local identity cleared, second account refreshed independently',
      missing_refresh_cookie: 'real 401, login expiration message',
    };
  } finally {
    await Promise.all([first.close(), second?.close()]);
  }
}

module.exports = { verifyAuth, signUpAndLogin };
