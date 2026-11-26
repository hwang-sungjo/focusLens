const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signUpAndLogin } = require('./fe2-auth.cjs');

const button = (page, name) => page.getByRole('button', { name, exact: true });

// Observe the app's own browser request, including its CORS/credential behavior.
async function actionResponse(page, url, method, action, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url() === url && item.request().method() === method),
    action(),
  ]);
  assert.equal(response.status(), status, `${method} ${new URL(url).pathname}`);
  return (await response.json()).data;
}

async function inviteAndJoin(sender, recipient, { origin, apiOrigin, groupId, groupName }) {
  await button(sender.page, '이메일로').click();
  await sender.page.getByLabel('초대할 이메일').fill(recipient.email);
  const invitation = await actionResponse(sender.page, `${apiOrigin}/api/groups/${groupId}/invite`, 'POST',
    () => button(sender.page, '초대 코드 만들기').click(), 201);
  const code = await sender.page.locator('code').innerText();
  assert.ok(code && code === invitation.invite_code, 'The displayed invitation must match the issued code');

  await recipient.page.goto(`${origin}/groups`);
  await recipient.page.getByLabel('초대 코드로 가입').fill(code).catch(() => {
    throw new Error('Could not enter the disposable group invitation');
  });
  const joined = await actionResponse(recipient.page, `${apiOrigin}/api/groups/join`, 'POST',
    () => button(recipient.page, '가입').click());
  assert.equal(joined.group_role, 'MEMBER');
  await recipient.page.getByRole('heading', { name: groupName, exact: true }).waitFor();
  await recipient.page.getByText('내 현황', { exact: true }).waitFor();
  return joined.member_id;
}

async function verifyGroups({ browser, origin, apiOrigin }) {
  const contexts = [];
  try {
    // Each user has independent cookies and storage. Test data belongs to the disposable stack.
    for (let i = 0; i < 4; i++) contexts.push(await browser.newContext());
    const [owner, manager, member, outsider] = await Promise.all(
      contexts.map(context => signUpAndLogin(context, origin, apiOrigin)),
    );
    const groupName = `FE2 study ${randomUUID().slice(0, 8)}`;
    await owner.page.goto(`${origin}/groups`);
    await button(owner.page, '+ 새 그룹').click();
    await owner.page.getByLabel('이름 (필수)').fill(groupName);
    const created = await actionResponse(owner.page, `${apiOrigin}/api/groups`, 'POST',
      () => button(owner.page, '만들기').click(), 201);
    const groupId = created.group_id;
    const settings = { origin, apiOrigin, groupId, groupName };
    const groupRoute = `/groups/${groupId}`;
    const groupApi = `${apiOrigin}/api${groupRoute}`;
    await owner.page.getByRole('heading', { name: groupName, exact: true }).waitFor();
    await owner.page.getByText('멤버 현황 1명', { exact: true }).waitFor();

    const managerMemberId = await inviteAndJoin(owner, manager, settings);
    await owner.page.reload();
    const promoted = await actionResponse(owner.page, `${groupApi}/members/${managerMemberId}`, 'PATCH',
      () => owner.page.getByLabel(`${manager.nickname} 역할`, { exact: true }).selectOption('MANAGER'));
    assert.equal(promoted.group_role, 'MANAGER');
    await manager.page.reload();
    await manager.page.getByText('멤버 현황 2명', { exact: true }).waitFor();
    await inviteAndJoin(manager, member, settings);

    for (const [actor, role, roleLabel] of [[owner, 'OWNER', '방장'], [manager, 'MANAGER', '매니저'], [member, 'MEMBER', '멤버']]) {
      const { page } = actor;
      await page.goto(`${origin}/groups`);
      const link = page.getByRole('link').filter({ hasText: groupName });
      await link.getByText(roleLabel, { exact: true }).waitFor();
      const dashboard = await actionResponse(page, `${groupApi}/dashboard?limit=100`, 'GET', () => link.click());
      const isMember = role === 'MEMBER';
      assert.equal(dashboard.scope, isMember ? 'self' : 'all_members');
      const expectedUsers = isMember ? [actor.userId] : [owner.userId, manager.userId, member.userId];
      assert.deepEqual(dashboard.members.map(row => row.user_id).sort(), expectedUsers.sort());
      await page.getByText(isMember ? '내 현황' : '멤버 현황 3명', { exact: true }).waitFor();
      const rows = page.getByRole('listitem').filter({ hasText: /세션 \d+개/ });
      assert.equal(await rows.count(), expectedUsers.length);
      assert.equal(await rows.getByRole('combobox').count(), role === 'OWNER' ? 2 : 0);
      assert.equal(await rows.getByRole('button', { name: '내보내기', exact: true }).count(),
        { OWNER: 2, MANAGER: 1, MEMBER: 0 }[role]);
      assert.equal(await page.getByText('멤버 초대', { exact: true }).count(), isMember ? 0 : 1);
    }

    await outsider.page.goto(`${origin}/groups`);
    await outsider.page.getByText('아직 속한 그룹이 없어요.', { exact: true }).waitFor();
    await actionResponse(outsider.page, groupApi, 'GET', () => outsider.page.goto(`${origin}${groupRoute}`), 403);
    await outsider.page.getByText('이 작업을 할 권한이 없습니다.', { exact: true }).waitFor();
    assert.equal(await button(outsider.page, '멤버').count(), 0);

    const goalTitle = `${groupName} goal`;
    await button(manager.page, '목표').click();
    await button(manager.page, '+ 새 목표').click();
    await manager.page.getByLabel('목표 이름', { exact: true }).fill(goalTitle);
    await manager.page.getByLabel('목표 학습 시간 (분, 선택)').fill('30');
    await actionResponse(manager.page, `${groupApi}/goals`, 'POST', () => button(manager.page, '목표 만들기').click(), 201);
    await manager.page.getByText(goalTitle, { exact: true }).waitFor();
    await button(member.page, '목표').click();
    await member.page.getByText(goalTitle, { exact: true }).waitFor();
    assert.equal(await button(member.page, '+ 새 목표').count(), 0);

    await button(manager.page, '피드백').click();
    const note = `${groupName} member feedback`;
    await manager.page.getByLabel('피드백 받을 멤버').selectOption({ label: member.nickname });
    await manager.page.getByLabel('피드백 내용').fill(note);
    await actionResponse(manager.page, `${groupApi}/feedbacks`, 'POST', () => button(manager.page, '남기기').click(), 201);
    await button(member.page, '피드백').click();
    await member.page.getByText(note, { exact: true }).waitFor();
    assert.equal(await member.page.getByLabel('피드백 내용').count(), 0);

    return {
      private_group: 'created via UI, owner and manager email invitations redeemed via UI',
      group_roles: ['OWNER', 'MANAGER', 'MEMBER'],
      dashboards: 'role labels, returned user IDs, member rows and management controls matched',
      outsider: 'private group absent from list; group detail returned 403 and rendered permission message',
      goals_and_feedback: 'manager created a goal and sent feedback; member saw both with read-only controls',
    };
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}

module.exports = { verifyGroups };
