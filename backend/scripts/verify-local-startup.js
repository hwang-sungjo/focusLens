// LBE-1: verify a separately started local API using only Node.js built-ins.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

function localBaseUrl() {
  assert.ok(process.env.LOCAL_VERIFY_URL, 'Set LOCAL_VERIFY_URL to the isolated local API origin');
  const url = new URL(process.env.LOCAL_VERIFY_URL);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'LOCAL_VERIFY_URL must be an explicit loopback HTTP origin with a port');
  return url.origin;
}

function refreshCookie(response, label) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = cookies.find((value) => value.startsWith('focuslens_refresh_token='));
  assert.ok(cookie, `${label}: Refresh cookie is present`);
  assert.ok(/;\s*HttpOnly(?:;|$)/i.test(cookie), `${label}: Refresh cookie is HttpOnly`);
  assert.ok(!/;\s*Secure(?:;|$)/i.test(cookie), `${label}: local HTTP cookie must not require HTTPS`);
  assert.ok(/;\s*SameSite=Lax(?:;|$)/i.test(cookie), `${label}: Refresh cookie uses SameSite=Lax`);
  assert.ok(/;\s*Path=\/api\/auth(?:;|$)/i.test(cookie), `${label}: Refresh cookie is scoped to auth routes`);
  assert.ok(!/;\s*Domain=/i.test(cookie), `${label}: local Refresh cookie is host-only`);
  return cookie.split(';', 1)[0];
}

async function verify(baseUrl) {
  const origin = 'http://localhost:5173';
  async function request(route, { method = 'GET', body, cookie, headers = {} } = {}, expectedStatus = 200) {
    const response = await fetch(baseUrl + route, {
      method,
      headers: {
        Origin: origin,
        ...(body && { 'Content-Type': 'application/json' }),
        ...(cookie && { Cookie: cookie }),
        ...headers,
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, expectedStatus, `${method} ${route}: expected HTTP ${expectedStatus}`);
    assert.equal(response.headers.get('access-control-allow-origin'), origin, `${route}: CORS origin`);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true', `${route}: CORS credentials`);
    return response;
  }
  async function data(response, label) {
    let envelope;
    try {
      envelope = await response.json();
    } catch (_error) {
      throw new Error(`${label}: expected a JSON response`);
    }
    assert.ok(envelope.success === true && envelope.data && typeof envelope.data === 'object',
      `${label}: successful response envelope`);
    assert.equal(envelope.error, '', `${label}: empty error field`);
    return envelope.data;
  }

  const health = await data(await request('/health'), 'health');
  assert.equal(health.status, 'ok', 'health status');
  assert.equal(health.db, 'connected', 'PostgreSQL connection');
  assert.equal(health.redis, 'connected', 'Redis connection');

  const docs = await request('/api-docs/');
  assert.ok((docs.headers.get('content-type') || '').includes('text/html'), 'Swagger UI is HTML');
  assert.ok((await docs.text()).includes('swagger-ui'), 'Swagger UI markup is present');
  const specificationResponse = await request('/api-docs/openapi.json');
  const specification = await specificationResponse.json();
  assert.ok(String(specification.openapi).startsWith('3.'), 'OpenAPI version');
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const operations = Object.values(specification.paths || {}).reduce((count, item) => (
    count + Object.keys(item).filter((method) => methods.has(method)).length
  ), 0);
  assert.equal(operations, 38, 'OpenAPI operation count');

  const preflight = await request('/api/auth/login', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  }, 204);
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map((value) => value.trim());
  assert.ok(allowedHeaders.includes('content-type') && allowedHeaders.includes('authorization'), 'CORS allows JSON and Authorization headers');
  assert.ok((preflight.headers.get('access-control-allow-methods') || '').split(',').includes('POST'), 'CORS allows POST');

  const id = randomUUID();
  const credentials = { email: `local-startup-${id}@example.test`, password: randomBytes(18).toString('hex') };
  const registration = await request('/api/auth/register', {
    method: 'POST', body: { ...credentials, name: 'Local startup verification', nickname: `local-${id.slice(0, 16)}` },
  }, 201);
  const registered = await data(registration, 'registration');
  refreshCookie(registration, 'registration');
  assert.ok(typeof registered.user_id === 'string' && registered.user_id.length > 0, 'registered user ID');

  const loginResponse = await request('/api/auth/login', { method: 'POST', body: credentials });
  const login = await data(loginResponse, 'login');
  assert.equal(login.user_id, registered.user_id, 'login returns the created account');
  assert.ok(typeof login.access_token === 'string' && login.access_token.length > 0, 'login access token');
  assert.equal(login.expires_in, 3600, 'one-hour Access Token lifetime');
  const cookie = refreshCookie(loginResponse, 'login');

  const refreshedResponse = await request('/api/auth/refresh', { method: 'POST', cookie });
  const refreshed = await data(refreshedResponse, 'cookie refresh');
  const rotatedCookie = refreshCookie(refreshedResponse, 'cookie refresh');
  assert.ok(rotatedCookie !== cookie, 'Refresh cookie rotates');
  assert.ok(typeof refreshed.access_token === 'string' && refreshed.access_token.length > 0,
    'cookie refresh returns an Access Token');

  console.log(JSON.stringify({
    result: 'LBE-1 local startup passed', api_origin: baseUrl,
    postgres: health.db, redis: health.redis, swagger_ui: true, openapi_operations: operations,
    registered_user_id: registered.user_id, login: true,
    cors_origin: origin, http_only_local_cookie: true, cookie_refresh_rotated: true,
  }, null, 2));
}

async function main() {
  await verify(localBaseUrl());
}

main().catch((error) => {
  console.error(`LBE-1 local startup verification failed: ${error.message}`);
  process.exitCode = 1;
});
