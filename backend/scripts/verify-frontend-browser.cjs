// FE-2 worker. The parent owns the disposable DB, CORS origin and temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { frontendOrigin } = require('./verify-handoff-stack');
const { verifyAuth } = require('./tests/fe2-auth.cjs');
const { verifyPrivacy } = require('./tests/fe2-privacy.cjs');
const { verifyGroups } = require('./tests/fe2-groups.cjs');

function failureLocation(error) {
  // Action logs can contain input values. Report only test source locations.
  return (error.stack || '').split('\n').filter(line => /^\s*at /.test(line))
    .map(line => line.match(/(?:fe2-[a-z]+|verify-frontend-browser)\.cjs:\d+:\d+/)?.[0])
    .filter(Boolean).slice(0, 3);
}

async function main() {
  const origin = frontendOrigin(process.env.LOCAL_FRONTEND_ORIGIN);
  const apiOrigin = frontendOrigin(process.env.LOCAL_VERIFY_URL);
  const frontend = new URL(origin);
  assert.equal(frontend.hostname, '127.0.0.1');
  assert.equal(new URL(apiOrigin).hostname, frontend.hostname);
  assert.match(process.env.COMPOSE_PROJECT_NAME || '', /^focuslens-handoff-[0-9a-f-]{36}$/);
  const root = path.resolve(__dirname, '../../frontend');
  const temporary = path.dirname(process.env.LOCAL_ENV_FILE);
  const outDir = await fs.mkdtemp(path.join(temporary, 'web-'));
  let server;
  let browser;
  let stage = 'build_frontend';
  try {
    const vite = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
    const config = { root, logLevel: 'silent', build: { outDir, emptyOutDir: false },
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiOrigin) } };
    await vite.build(config);
    stage = 'serve_production_build';
    server = await vite.preview({ ...config,
      preview: { host: frontend.hostname, port: Number(frontend.port), strictPort: true, open: false } });
    stage = 'launch_chromium';
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true });
    stage = 'browser_scenarios';
    const checks = {};
    const failures = {};
    // Each scenario creates independent accounts, and the scored fixture needs one real minute.
    await Promise.all(Object.entries({ auth: verifyAuth, privacy: verifyPrivacy, groups: verifyGroups })
      .map(async ([name, run]) => {
        try { checks[name] = await run({ browser, origin, apiOrigin }); }
        catch (error) { failures[name] = { type: error.name, location: failureLocation(error) }; }
      }));
    const passed = Object.keys(failures).length === 0;
    if (!passed) process.exitCode = 1;
    console.log(JSON.stringify({ passed, chromium_version: browser.version(), checks, failures }));
  } catch (error) {
    process.exitCode = 1;
    console.error(JSON.stringify({ stage, type: error.name, location: failureLocation(error),
      ...(stage === 'launch_chromium' && { hint: 'Install the matching browser with npx playwright-core install chromium.' }) }));
  } finally {
    await browser?.close();
    await server?.close();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ error: 'Browser worker setup or cleanup failed. Run npm run verify:fe2.' }));
  process.exitCode = 1;
});
