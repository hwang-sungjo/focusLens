// LBE-5: HTTP contracts for an isolated local stack. Each actor owns a cookie jar.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

function loopbackOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error(`${label} must be an explicit local HTTP origin.`); }
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  `${label} must be an explicit local HTTP origin.`);
  return url.origin;
}

function cookieFrom(response, label, { cleared = false } = {}) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = cookies.find(value => value.startsWith('focuslens_refresh_token='));
  assert.ok(cookie, `${label}: Refresh cookie exists`);
  for (const [pattern, description] of [
    [/;\s*HttpOnly(?:;|$)/i, 'HttpOnly'],
    [/;\s*SameSite=Lax(?:;|$)/i, 'SameSite=Lax'],
    [/;\s*Path=\/api\/auth(?:;|$)/i, 'auth path'],
  ]) assert.ok(pattern.test(cookie), `${label}: Refresh cookie uses ${description}`);
  assert.ok(!/;\s*Domain=/i.test(cookie), `${label}: cookie is host-only`);
  assert.ok(!/;\s*Secure(?:;|$)/i.test(cookie), `${label}: local HTTP cookie is not HTTPS-only`);
  const pair = cookie.split(';', 1)[0];
  if (cleared) {
    assert.ok(pair === 'focuslens_refresh_token=' && /;\s*Expires=/i.test(cookie), `${label}: cookie is cleared`);
  } else assert.ok(pair.length > 'focuslens_refresh_token='.length + 20, `${label}: cookie has an opaque value`);
  return pair;
}

function claims(token, label) {
  try {
    const body = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    assert.ok(body && typeof body.sub === 'string' && body.exp - body.iat === 3600);
    return body;
  } catch (_) { throw new Error(`${label}: Access Token has the expected one-hour claims`); }
}

async function verify(baseUrl, origin) {
  let stage = 'health_and_cors';
  const checks = [];
  const progress = value => { stage = value; };
  const checked = name => checks.push(name);
  let requests = 0;

  async function request(route, { actor, method = 'GET', body, cookie, token,
    cookieOnly = false, headers = {} } = {}, expected = 200) {
    requests += 1;
    const authCookie = cookie || (route.startsWith('/api/auth/') ? actor?.cookie : undefined);
    const response = await fetch(baseUrl + route, {
      method,
      headers: {
        Origin: origin,
        ...(body && { 'Content-Type': 'application/json' }),
        ...(authCookie && { Cookie: authCookie }),
        ...(!cookieOnly && (token || actor?.token) && { Authorization: `Bearer ${token || actor.token}` }),
        ...headers,
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, expected, `${stage}: ${method} ${route}: HTTP status`);
    assert.equal(response.headers.get('access-control-allow-origin'), origin, `${stage}: allowed CORS origin`);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true', `${stage}: credential CORS`);
    if (expected === 204) return { response };
    const exposed = (response.headers.get('access-control-expose-headers') || '').toLowerCase().split(',').map(value => value.trim());
    assert.ok(exposed.includes('x-request-id'), `${stage}: request ID is visible to the frontend`);
    assert.ok(response.headers.get('x-request-id'), `${stage}: request ID is returned`);
    let envelope;
    try { envelope = await response.json(); } catch (_) { throw new Error(`${stage}: API response must be JSON`); }
    assert.ok(envelope && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      && typeof envelope.error === 'string', `${stage}: uniform API response`);
    assert.equal(envelope.success, expected < 400, `${stage}: response success flag`);
    assert.ok(expected < 400 ? envelope.error === '' : envelope.error.length > 0, `${stage}: response error field`);
    return { data: envelope.data, response };
  }

  async function login(actor) {
    const { data, response } = await request('/api/auth/login', { method: 'POST', body: actor.credentials });
    assert.equal(data.user_id, actor.id, 'Login identifies its own actor');
    assert.equal(data.expires_in, 3600, 'Access Token lifetime');
    actor.token = data.access_token;
    actor.cookie = cookieFrom(response, 'Login');
    assert.equal(claims(actor.token, 'Login').sub, actor.id, 'Login JWT subject');
    return actor;
  }

  async function register(name) {
    const id = randomUUID();
    const actor = { name, credentials: {
      email: `handoff-${name}-${id}@example.test`, password: randomBytes(24).toString('hex'),
    } };
    const { data, response } = await request('/api/auth/register', { method: 'POST', body: {
      ...actor.credentials, name: `Handoff ${name}`, nickname: `h${name}-${id.slice(0, 16)}`,
    } }, 201);
    actor.id = data.user_id;
    actor.cookie = cookieFrom(response, 'Registration');
    assert.equal(claims(data.access_token, 'Registration').sub, actor.id, 'Registration JWT subject');
    return login(actor);
  }

  async function refresh(actor) {
    const oldCookie = actor.cookie;
    const { data, response } = await request('/api/auth/refresh', { actor, method: 'POST', cookieOnly: true });
    actor.cookie = cookieFrom(response, 'Cookie-only Refresh');
    assert.ok(actor.cookie !== oldCookie, 'Refresh rotates the actor cookie');
    actor.token = data.access_token;
    assert.equal(claims(actor.token, 'Cookie-only Refresh').sub, actor.id, 'Refresh stays within its actor');
  }

  const privacy = (actor, body) => request('/api/users/me/privacy', { actor, method: 'PATCH', body });
  const feed = async (actor, scope = 'all') => {
    const { data } = await request(`/api/session-shares/feed?scope=${scope}&limit=100`, { actor });
    assert.ok(Array.isArray(data.feed), 'Feed is paginated under data.feed');
    return data.feed;
  };
  const contains = (rows, share) => rows.some(row => row.share_id === share);
  const reaction = (actor, share, expected = 201) => request(`/api/session-shares/${share}/reactions`, {
    actor, method: 'POST', body: { reaction_type: 'LIKE' },
  }, expected);
  const share = async (actor, session, scope, group) => (await request('/api/session-shares', {
    actor, method: 'POST', body: { session_id: session, share_scope: scope,
      ...(group && { group_id: group }), share_message: 'Local handoff verification' },
  }, 201)).data.share_id;

  try {
    const { data: health } = await request('/health');
    assert.ok(health.db === 'connected' && health.redis === 'connected', 'Isolated backend dependencies are ready');
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const { response } = await request('/api/users/me/privacy', { method: 'OPTIONS', headers: {
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'content-type,authorization',
      } }, 204);
      const methods = (response.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim());
      const headers = (response.headers.get('access-control-allow-headers') || '').toLowerCase();
      assert.ok(methods.includes(method) && headers.includes('authorization') && headers.includes('content-type'),
        'Preflight allows the frontend method and auth headers');
    }
    // Browsers reject an Origin that does not match the allowed response origin.
    const deniedOrigin = 'http://localhost:59999';
    requests += 1;
    const denied = await fetch(baseUrl + '/health', { headers: { Origin: deniedOrigin }, signal: AbortSignal.timeout(15_000) });
    assert.ok(denied.headers.get('access-control-allow-origin') !== deniedOrigin, 'Unknown origins are not authorized by CORS');
    checked('CORS, preflight and request IDs');

    progress('independent_accounts_and_refresh_cookie_rotation');
    const owner = await register('owner');
    const manager = await register('manager');
    const member = await register('member');
    assert.ok(new Set([owner.cookie, manager.cookie, member.cookie]).size === 3, 'Each account owns an independent cookie jar');
    for (const actor of [owner, manager, member]) {
      await refresh(actor);
      const { data } = await request('/api/users/me/privacy', { actor });
      assert.equal(data.default_session_scope, 'PRIVATE', 'New accounts default to PRIVATE');
      assert.equal(data.ranking_participation, false, 'New accounts do not opt into rankings');
    }
    const admin = { credentials: {
      email: process.env.LOCAL_HANDOFF_ADMIN_EMAIL || 'admin@focuslens.dev',
      password: process.env.LOCAL_HANDOFF_ADMIN_PASSWORD || 'password_admin123!',
    } };
    const adminLogin = await request('/api/auth/login', { method: 'POST', body: admin.credentials });
    admin.id = adminLogin.data.user_id;
    admin.token = adminLogin.data.access_token;
    admin.cookie = cookieFrom(adminLogin.response, 'Seed ADMIN login');
    assert.equal(claims(admin.token, 'Seed ADMIN').role, 'ADMIN', 'Global ADMIN fixture is actually an administrator');
    checked('Independent cookie jars and cookie-only Refresh rotation');

    progress('session_ownership_and_empty_report_contract');
    const started = (await request('/api/sessions/start', { actor: owner, method: 'POST', body: {} }, 201)).data;
    const sessionId = started.session_id;
    await request(`/api/sessions/${sessionId}`, { actor: manager }, 403);
    await request(`/api/sessions/${sessionId}/end`, { actor: manager, method: 'POST' }, 403);
    const ownSessions = (await request('/api/sessions?status=IN_PROGRESS', { actor: manager })).data.sessions;
    assert.ok(!ownSessions.some(row => row.session_id === sessionId), 'Session lists are owner-scoped');
    // A real one-second session makes duration visibility observable without fake scores or backdating.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const ended = (await request(`/api/sessions/${sessionId}/end`, { actor: owner, method: 'POST' })).data;
    assert.equal(ended.status, 'COMPLETED', 'Owner can complete the session');
    assert.equal(ended.summary.total_logs, 0, 'Empty sessions do not manufacture AI logs');
    assert.ok(ended.summary.duration_seconds >= 1, 'Session duration uses actual elapsed time');
    const report = (await request(`/api/reports/${sessionId}`, { actor: owner })).data;
    assert.equal(report.summary_json.avg_focus_score, null, 'No-score report uses null average');
    assert.ok(Array.isArray(report.timeline) && report.timeline.length === 0, 'No-score report has an empty timeline');
    await request(`/api/reports/${sessionId}`, { actor: manager }, 403);
    checked('Session and report ownership with a real empty session');

    progress('friendship_feed_reactions_and_live_privacy_changes');
    await request('/api/session-shares', { actor: owner, method: 'POST', body: {
      session_id: sessionId, share_scope: 'PUBLIC',
    } }, 403);
    await privacy(owner, { default_session_scope: 'FRIENDS', score_visibility: 'PRIVATE', study_time_visibility: 'PRIVATE' });
    const friendsShare = await share(owner, sessionId, 'FRIENDS');
    assert.ok(!contains(await feed(manager), friendsShare), 'Nonfriends cannot see a FRIENDS share');
    await reaction(manager, friendsShare, 403);
    const connection = (await request('/api/connections/request', { actor: owner, method: 'POST',
      body: { receiver_user_id: manager.id } }, 201)).data;
    await request(`/api/connections/${connection.request_id}`, { actor: owner, method: 'PATCH', body: { status: 'ACCEPTED' } }, 403);
    await request(`/api/connections/${connection.request_id}`, { actor: member, method: 'PATCH', body: { status: 'ACCEPTED' } }, 403);
    await request(`/api/connections/${connection.request_id}`, { actor: manager, method: 'PATCH', body: { status: 'ACCEPTED' } });
    const connections = (await request('/api/connections', { actor: manager })).data.connections;
    assert.ok(connections.some(row => row.user_id === owner.id), 'Accepted friend request appears in connections');
    const friendEntry = (await feed(manager, 'friends')).find(row => row.share_id === friendsShare);
    assert.ok(friendEntry, 'Accepted friends can see the FRIENDS share');
    assert.equal(friendEntry.session_summary.duration_seconds, null, 'Private study duration is masked');
    assert.equal(friendEntry.session_summary.avg_focus_score, null, 'Private/no-score average stays null');
    assert.ok(!contains(await feed(member), friendsShare), 'Another account does not inherit friendship');
    await reaction(member, friendsShare, 403);
    await request('/api/session-shares', { actor: owner, method: 'POST', body: {
      session_id: sessionId, share_scope: 'PUBLIC',
    } }, 403);
    await privacy(owner, { default_session_scope: 'PUBLIC', study_time_visibility: 'PUBLIC' });
    const publicShare = await share(owner, sessionId, 'PUBLIC');
    let publicEntry = (await feed(member, 'public')).find(row => row.share_id === publicShare);
    assert.ok(publicEntry && publicEntry.session_summary.duration_seconds >= 1, 'Public duration is visible to nonfriends');
    assert.equal(publicEntry.session_summary.avg_focus_score, null, 'A public empty session still has no score');
    await reaction(member, publicShare);
    await reaction(member, publicShare, 409);
    publicEntry = (await feed(member, 'public')).find(row => row.share_id === publicShare);
    assert.equal(publicEntry.reaction_counts.LIKE, 1, 'Reaction View counts one unique reaction');
    assert.ok(publicEntry.my_reactions.includes('LIKE'), 'Viewer reaction is returned separately');
    await request(`/api/session-shares/${publicShare}/reactions/LIKE`, { actor: member, method: 'DELETE' });
    publicEntry = (await feed(member, 'public')).find(row => row.share_id === publicShare);
    assert.equal(publicEntry.reaction_counts.LIKE, 0, 'Reaction cancellation updates the View');
    await privacy(owner, { default_session_scope: 'PRIVATE' });
    assert.ok(!contains(await feed(manager), friendsShare) && !contains(await feed(member), publicShare),
      'Narrowed privacy immediately removes prior shares from feeds');
    await reaction(manager, friendsShare, 403);
    await reaction(member, publicShare, 403);
    await privacy(owner, { default_session_scope: 'PUBLIC' });
    assert.ok(contains(await feed(member, 'public'), publicShare), 'Widened privacy restores an eligible prior share');
    checked('Friendship, share scopes, duration masking and reaction privacy');

    progress('group_membership_roles_and_global_admin_boundaries');
    const group = (await request('/api/groups', { actor: owner, method: 'POST', body: {
      name: `Handoff ${randomUUID()}`, group_type: 'STUDY', visibility: 'PRIVATE',
    } }, 201)).data;
    const groupId = group.group_id;
    assert.equal(group.my_role, 'OWNER', 'Creating a group creates an OWNER membership');
    const goalBody = { title: 'Handoff goal', target_study_minutes: 25,
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10) };
    for (const actor of [manager, admin]) {
      await request(`/api/groups/${groupId}/dashboard`, { actor }, 403);
      await request(`/api/groups/${groupId}/goals`, { actor, method: 'POST', body: goalBody }, 403);
      await request(`/api/groups/${groupId}/invite`, { actor, method: 'POST', body: { invitee_user_id: member.id } }, 403);
    }
    const invite = async (actor, target) => (await request(`/api/groups/${groupId}/invite`, {
      actor, method: 'POST', body: { invitee_user_id: target.id },
    }, 201)).data;
    const managerInvitation = await invite(owner, manager);
    await request('/api/groups/join', { actor: member, method: 'POST', body: { invite_code: managerInvitation.invite_code } }, 403);
    const managerMembership = (await request('/api/groups/join', { actor: manager, method: 'POST',
      body: { invite_code: managerInvitation.invite_code } })).data;
    assert.equal(managerMembership.group_role, 'MEMBER', 'Joining always grants MEMBER');
    await request(`/api/groups/${groupId}/goals`, { actor: manager, method: 'POST', body: goalBody }, 403);
    await request(`/api/groups/${groupId}/members/${managerMembership.member_id}`, { actor: manager, method: 'PATCH',
      body: { group_role: 'MANAGER' } }, 403);
    await request(`/api/groups/${groupId}/members/${managerMembership.member_id}`, { actor: owner, method: 'PATCH',
      body: { group_role: 'MANAGER' } });
    const goal = (await request(`/api/groups/${groupId}/goals`, { actor: manager, method: 'POST', body: goalBody }, 201)).data;
    assert.ok(goal.goal_id, 'A MANAGER membership can create a goal');
    const memberInvitation = await invite(manager, member);
    const memberMembership = (await request('/api/groups/join', { actor: member, method: 'POST',
      body: { invite_code: memberInvitation.invite_code } })).data;
    await request(`/api/groups/${groupId}/goals`, { actor: member, method: 'POST', body: goalBody }, 403);
    await request(`/api/groups/${groupId}/invite`, { actor: member, method: 'POST', body: { invitee_user_id: admin.id } }, 403);
    for (const actor of [owner, manager]) {
      const dashboard = (await request(`/api/groups/${groupId}/dashboard`, { actor })).data;
      assert.equal(dashboard.scope, 'all_members', 'OWNER and MANAGER can read all member rows');
      assert.equal(dashboard.members.length, 3, 'Management dashboard includes all active memberships');
    }
    const memberDashboard = (await request(`/api/groups/${groupId}/dashboard`, { actor: member })).data;
    assert.equal(memberDashboard.scope, 'self', 'MEMBER dashboard is self-scoped');
    assert.ok(memberDashboard.members.length === 1 && memberDashboard.members[0].user_id === member.id,
      'MEMBER cannot read another member row');
    checked('Group membership roles and no global ADMIN bypass');

    progress('group_data_sharing_group_feed_and_owner_transfer');
    const memberSession = (await request('/api/sessions/start', { actor: member, method: 'POST', body: {} }, 201)).data;
    await request(`/api/sessions/${memberSession.session_id}/end`, { actor: member, method: 'POST' });
    let managedRows = (await request(`/api/groups/${groupId}/dashboard`, { actor: owner })).data.members;
    assert.equal(managedRows.find(row => row.user_id === member.id).total_sessions, 1, 'Consenting member stats are aggregated');
    await privacy(member, { group_data_sharing: false });
    managedRows = (await request(`/api/groups/${groupId}/dashboard`, { actor: manager })).data.members;
    const hiddenStats = managedRows.find(row => row.user_id === member.id);
    assert.ok(hiddenStats && hiddenStats.total_sessions === 0 && hiddenStats.total_study_seconds === 0
      && hiddenStats.avg_focus_score === null && hiddenStats.last_session_at === null,
    'Disabling group data sharing keeps the member row and hides aggregate stats');
    await privacy(owner, { default_session_scope: 'GROUP' });
    const groupShare = await share(owner, sessionId, 'GROUP', groupId);
    assert.ok(contains(await feed(member), groupShare), 'An active group member can read the GROUP share');
    assert.ok(!contains(await feed(admin), groupShare), 'Global ADMIN outside the group cannot read the GROUP share');
    await reaction(admin, groupShare, 403);
    await privacy(owner, { default_session_scope: 'PRIVATE' });
    assert.ok(!contains(await feed(member), groupShare), 'Owner privacy also limits GROUP shares');
    await reaction(member, groupShare, 403);
    await privacy(owner, { default_session_scope: 'GROUP' });
    await request(`/api/groups/${groupId}/members/${managerMembership.member_id}`, { actor: owner, method: 'PATCH',
      body: { group_role: 'OWNER' } });
    assert.equal((await request(`/api/groups/${groupId}`, { actor: owner })).data.my_role, 'MANAGER',
      'Transferring OWNER demotes the original creator to MANAGER');
    assert.equal((await request(`/api/groups/${groupId}`, { actor: manager })).data.my_role, 'OWNER',
      'Transferred membership is now the OWNER');
    await request(`/api/groups/${groupId}/members/${memberMembership.member_id}`, { actor: owner, method: 'PATCH',
      body: { group_role: 'MANAGER' } }, 403);
    await request(`/api/groups/${groupId}/members/${memberMembership.member_id}`, { actor: manager, method: 'PATCH',
      body: { group_role: 'MANAGER' } });
    await request(`/api/groups/${groupId}/members/${memberMembership.member_id}`, { actor: owner, method: 'DELETE' }, 403);
    await request(`/api/groups/${groupId}/members/${memberMembership.member_id}`, { actor: manager, method: 'DELETE' });
    await request(`/api/groups/${groupId}/dashboard`, { actor: member }, 403);
    assert.ok(!contains(await feed(member), groupShare), 'Removed members lose GROUP feed access');
    await reaction(member, groupShare, 403);
    const adminInvitation = await invite(manager, admin);
    const adminMembership = (await request('/api/groups/join', { actor: admin, method: 'POST',
      body: { invite_code: adminInvitation.invite_code } })).data;
    assert.equal(adminMembership.group_role, 'MEMBER', 'A global ADMIN joins as an ordinary group MEMBER');
    await request(`/api/groups/${groupId}/goals`, { actor: admin, method: 'POST', body: goalBody }, 403);
    await request(`/api/groups/${groupId}/members/${adminMembership.member_id}`, { actor: admin,
      method: 'PATCH', body: { group_role: 'OWNER' } }, 403);
    const adminDashboard = (await request(`/api/groups/${groupId}/dashboard`, { actor: admin })).data;
    assert.ok(adminDashboard.scope === 'self' && adminDashboard.members.length === 1,
      'Global ADMIN membership still receives only its MEMBER dashboard scope');
    checked('Group data consent, GROUP feed access and OWNER transfer');

    progress('logout_revokes_its_access_and_cookie_without_cross_account_leakage');
    const oldAccess = owner.token;
    const oldCookie = owner.cookie;
    const logout = await request('/api/auth/logout', { actor: owner, method: 'POST' });
    cookieFrom(logout.response, 'Logout', { cleared: true });
    await request('/api/users/me/privacy', { token: oldAccess }, 401);
    await request('/api/auth/refresh', { method: 'POST', cookie: oldCookie, cookieOnly: true }, 401);
    await request('/api/users/me/privacy', { actor: manager });
    await refresh(manager);
    checked('Logout and independent account sessions');

    console.log(JSON.stringify({
      result: 'LBE-5 frontend handoff HTTP contracts passed',
      api_origin: baseUrl, frontend_origin: origin, requests,
      actors: { registered_users: 3, seeded_global_admin: true },
      checks, session_backdated: false, fabricated_score_logs: false,
      score_visibility_evidence: 'Empty-session null contract; non-null score masking is not asserted',
      cookie_verification: 'Independent HTTP cookie jars; browser SameSite policy requires separate browser verification',
    }, null, 2));
  } catch (error) {
    throw new Error(`LBE-5 failed at ${stage}: ${error.message}`, { cause: error });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: LOCAL_VERIFY_URL=http://127.0.0.1:PORT node backend/scripts/verify-frontend-handoff.js');
    console.log('Uses an isolated preseeded stack, LOCAL_FRONTEND_ORIGIN (default http://localhost:5173), and in-memory credentials only.');
    return;
  }
  assert.equal(args.length, 0, 'Only --help is accepted');
  assert.ok(process.env.LOCAL_VERIFY_URL, 'LOCAL_VERIFY_URL must identify the disposable stack');
  await verify(loopbackOrigin(process.env.LOCAL_VERIFY_URL, 'LOCAL_VERIFY_URL'),
    loopbackOrigin(process.env.LOCAL_FRONTEND_ORIGIN || 'http://localhost:5173', 'LOCAL_FRONTEND_ORIGIN'));
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ result: 'LBE-5 frontend handoff failed', error: error.message }));
  process.exitCode = 1;
});

module.exports = { verify, loopbackOrigin };
