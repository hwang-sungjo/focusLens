// FE-2 and FE-3 exercise the actual production frontend against the isolated stack.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { frontendOrigin, cameraProgress } = require('./verify-handoff-stack');
const { verifyAuth } = require('./tests/fe2-auth.cjs');
const { verifyPrivacy } = require('./tests/fe2-privacy.cjs');
const { verifyGroups } = require('./tests/fe2-groups.cjs');
const { startCompanion, checkQueue, verifyMeasurement } = require('./tests/fe3-measurement.cjs');

function failureLocation(error) {
  // Action logs can contain input values. Report only test source locations.
  return (error.stack || '').split('\n').filter(line => /^\s*at /.test(line))
    .map(line => line.match(/(?:fe[23]-[a-z]+|verify-frontend-browser)\.cjs:\d+:\d+/)?.[0])
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
  const bridgeMode = process.argv[2] === '--fe3';
  const mode = process.argv[3] === '--live' ? 'live' : 'fixture';
  let companion;
  let server;
  let browser;
  let stage = 'build_frontend';
  try {
    if (bridgeMode) {
      stage = 'start_isolated_python_companion';
      companion = await startCompanion(mode);
    }
    stage = 'build_frontend';
    const vite = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
    const config = { root, logLevel: 'silent', build: { outDir, emptyOutDir: false },
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiOrigin),
        // The FE-2 idle screen must never contact an existing developer companion.
        'import.meta.env.VITE_LOCAL_AI_ORIGIN': JSON.stringify(companion?.origin || apiOrigin) } };
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
    const scenarios = bridgeMode ? { measurement: verifyMeasurement } : { auth: verifyAuth, privacy: verifyPrivacy, groups: verifyGroups };
    await Promise.all(Object.entries(scenarios)
      .map(async ([name, run]) => {
        try { checks[name] = await run({ browser, origin, apiOrigin, bridgeOrigin: companion?.origin, mode, temporary }); }
        catch (error) {
          failures[name] = { type: error.name, location: failureLocation(error) };
          if (mode === 'live') {
            const knownReasons = ['camera_or_local_state_unavailable', 'camera_in_use', 'camera_open_failed',
              'camera_read_failed', 'camera_inference_failed', 'model_unavailable', 'camera_dependencies_unavailable',
              'browser_disconnected', 'camera_paused'];
            if (error.capture?.phase === 'paused') failures[name].capture = {
              phase: 'paused', reason: knownReasons.includes(error.capture.reason) ? error.capture.reason : 'unknown',
            };
            failures[name].progress = await cameraProgress(temporary);
          }
        }
      }));
    if (companion) {
      stage = 'verify_durable_queue';
      const result = await companion.stop();
      companion = null;
      assert.equal(result, 0);
      if (checks.measurement) {
        await checkQueue(temporary, checks.measurement);
        checks.measurement.sqlite_sent_and_ended = true;
      }
    }
    const passed = Object.keys(failures).length === 0;
    if (!passed) process.exitCode = 1;
    console.log(JSON.stringify({ passed, chromium_version: browser.version(), checks, failures }));
  } catch (error) {
    process.exitCode = 1;
    console.error(JSON.stringify({ stage, type: error.name, location: failureLocation(error),
      ...(stage === 'launch_chromium' && { hint: 'Install the matching browser with npx playwright-core install chromium.' }) }));
  } finally {
    await Promise.all([browser?.close(), server?.close(), companion?.stop()]);
  }
}

main().catch(() => {
  console.error(JSON.stringify({ error: 'Browser worker setup or cleanup failed. Run npm run verify:fe2.' }));
  process.exitCode = 1;
});
