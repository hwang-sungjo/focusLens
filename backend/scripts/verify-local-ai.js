// LBE-4 uses the ordinary local API. Only this verifier's proxy injects outages.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { defaultAiPython } = require('./local-ai-python');

const repoRoot = path.resolve(__dirname, '../..');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PRIVATE_KEYS = new Set(['password', 'password_hash', 'access_token', 'refresh_token', 'credentials', 'authorization']);
const round = value => Math.round(value * 100) / 100;
const scoreState = value => value >= 70 ? 'FOCUSED' : value >= 40 ? 'NORMAL' : 'DISTRACTED';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, publicData(item)]),
  );
  return value;
}

function options(argv) {
  const result = { baseUrl: process.env.LOCAL_AI_VERIFY_URL || 'http://localhost:3000',
    cameraIndex: Number(process.env.AI2_CAMERA_INDEX || '0') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (['--base-url', '--camera-index', '--resume-evidence'].includes(arg) && argv[index + 1]) {
      const value = argv[++index];
      if (arg === '--base-url') result.baseUrl = value;
      else if (arg === '--resume-evidence') result.resumeEvidence = path.resolve(value);
      else result.cameraIndex = Number(value);
    } else throw new Error('Usage: node backend/scripts/verify-local-ai.js [--base-url URL] [--camera-index N] [--resume-evidence DIR]');
  }
  if (result.help) return result;
  const url = new URL(result.baseUrl);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Verification requires an explicit local HTTP origin with a port');
  assert.ok(Number.isSafeInteger(result.cameraIndex) && result.cameraIndex >= 0, 'Camera index must be a nonnegative integer');
  result.baseUrl = url.origin;
  return result;
}

async function command(program, args, { env, signal, operation }) {
  const child = spawn(program, args, { cwd: repoRoot, env, signal, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let timedOut = false;
  let forceKill;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
    forceKill.unref();
  }, 30_000);
  deadline.unref();
  child.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
    if (output.length > 4 * 1024 * 1024) child.kill('SIGTERM');
  });
  return new Promise((resolve, reject) => {
    child.once('error', () => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      reject(new Error(`${operation} could not start.`));
    });
    child.once('close', code => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      if (code === 0 && !timedOut) resolve(output.trim());
      else reject(new Error(`${operation} ${timedOut ? 'timed out' : 'failed'}.`));
    });
  });
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log('Usage: node backend/scripts/verify-local-ai.js [--base-url URL] [--camera-index N] [--resume-evidence DIR]');
    console.log('Requires a running ordinary local stack and a prepared webcam. Measures two real minutes without changing session times.');
    console.log('Creates one verification account/session; saves private queue and noncredential evidence under .local/ai-verification/.');
    console.log('--resume-evidence resumes saved camera results, the existing proxy origin and Keychain; it never measures or logs in again.');
    return;
  }
  const controller = new AbortController();
  const activeChildren = new Set();
  const interrupt = () => {
    controller.abort();
    for (const child of activeChildren) child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const env = { ...process.env };
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const project = process.env.LOCAL_AI_VERIFY_PROJECT || process.env.COMPOSE_PROJECT_NAME || path.basename(repoRoot).toLowerCase();
  assert.match(project, /^[a-z0-9][a-z0-9_-]*$/, 'Use a valid local Compose project name');
  const compose = ['compose', '--project-directory', repoRoot, '-p', project, '-f', path.join(repoRoot, 'docker-compose.yml')];
  const sql = query => command('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'focuslens', '-d', 'focuslens', '-Atc', query], { env, signal: controller.signal, operation: 'Read verification fixture from local PostgreSQL' });
  const request = async (route, { method = 'GET', body, token } = {}, expected = 200) => {
    const response = await fetch(config.baseUrl + route, {
      method, headers: { ...(body && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    assert.equal(response.status, expected, `API ${method} request returned unexpected status`);
    const envelope = await response.json();
    assert.equal(envelope.success, expected < 400, 'API envelope status');
    return envelope.data;
  };
  let stage = 'prepare';
  let directory;
  let proxy;
  let proxyUrl;
  let result;
  let evidence = { source: 'camera', virtual_clock: false, session_backdated: false,
    log_payloads: [], blocked_log_requests: 0, lost_log_acknowledgements: 0, workers: [] };
  const progress = value => { stage = value; console.log(JSON.stringify({ stage })); };
  const faults = { offline: true, dropOnce: false };
  try {
    const health = await request('/health');
    assert.ok(health.db === 'connected' && health.redis === 'connected', 'Ordinary local backend must be healthy');
    let credentials;
    let registered;
    let localState;
    let restoredProxy;
    if (config.resumeEvidence) {
      progress('load_existing_camera_evidence_without_new_capture_or_login');
      const verificationRoot = await fs.realpath(path.join(repoRoot, '.local', 'ai-verification'));
      const resolved = await fs.realpath(config.resumeEvidence);
      const relative = path.relative(verificationRoot, resolved);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        && !relative.includes(path.sep), 'Resume evidence must be a direct directory under this repository .local/ai-verification');
      const evidenceFile = path.join(resolved, 'evidence.json');
      const stateFile = path.join(resolved, 'state', 'session.json');
      for (const file of [evidenceFile, stateFile]) {
        const info = await fs.lstat(file);
        assert.ok(info.isFile() && !info.isSymbolicLink(), 'Resume evidence and session state must be regular private files');
      }
      const originalEvidence = await fs.readFile(evidenceFile);
      const saved = JSON.parse(originalEvidence.toString('utf8'));
      localState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      assert.ok(saved.source === 'camera' && saved.virtual_clock === false && saved.session_backdated === false,
        'Resume requires evidence from actual camera measurement');
      assert.match(saved.user_id, UUID);
      assert.match(saved.session_id, UUID);
      assert.equal(localState.user_id, saved.user_id, 'Saved queue owner matches verification account');
      assert.equal(localState.session_id, saved.session_id, 'Saved queue session matches verification session');
      assert.equal(localState.origin, saved.delivery_origin, 'Saved Keychain origin matches the original proxy');
      assert.equal(localState.phase, 'closing', 'Resume requires the existing unfinished camera session');
      restoredProxy = new URL(saved.delivery_origin);
      assert.ok(restoredProxy.protocol === 'http:' && restoredProxy.hostname === '127.0.0.1'
        && restoredProxy.port && !restoredProxy.username && !restoredProxy.password
        && restoredProxy.pathname === '/' && !restoredProxy.search && !restoredProxy.hash,
      'Resume proxy must use its original explicit loopback origin');
      const originalWorker = saved.workers?.find(worker => worker.action === 'measure');
      const started = originalWorker?.events?.find(event => event.event === 'session_started');
      assert.equal(started?.session_id, saved.session_id, 'Original measurement start receipt matches saved session');
      assert.equal(Date.parse(started.started_at), Date.parse(localState.started_at), 'Saved start time matches the original API receipt');
      const initialFile = path.join(resolved, 'initial-evidence.json');
      try { await fs.writeFile(initialFile, originalEvidence, { mode: 0o600, flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = JSON.parse(await fs.readFile(initialFile, 'utf8'));
        assert.equal(prior.user_id, saved.user_id, 'Initial evidence remains bound to this account');
        assert.equal(prior.session_id, saved.session_id, 'Initial evidence remains bound to this session');
      }
      directory = resolved;
      evidence = saved;
      evidence.resume_history = [...(evidence.resume_history || []), { resumed_at: new Date().toISOString(),
        camera_remeasured: false, login_repeated: false, original_evidence_preserved: true }];
      registered = { user_id: saved.user_id };
    } else {
      directory = path.join(repoRoot, '.local', 'ai-verification',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(directory, 'state'), { mode: 0o700 });
      const unique = randomUUID();
      credentials = { email: `local-ai-${unique}@example.test`, password: randomBytes(24).toString('hex') };
      progress('register_one_local_verification_account');
      registered = await request('/api/auth/register', { method: 'POST', body: {
        ...credentials, name: 'Local AI verification', nickname: `localai-${unique.slice(0, 16)}`,
      } }, 201);
    }
    const stateDirectory = path.join(directory, 'state');
    assert.match(registered.user_id, UUID, 'Verification account UUID');
    let token = registered.access_token;
    evidence.user_id = registered.user_id;
    assert.equal(await sql(`SELECT count(*) FROM users WHERE id='${registered.user_id}'`), '1',
      'Verification API and Compose PostgreSQL must reference the same local stack');

    proxy = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) throw new Error('Body too large');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const isLog = req.method === 'POST' && /^\/api\/v2\/sessions\/[a-f0-9-]+\/log$/.test(req.url);
        if (isLog) evidence.log_payloads.push(publicData(JSON.parse(body.toString('utf8'))));
        if (isLog && faults.offline) {
          evidence.blocked_log_requests += 1;
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, data: {}, error: 'verification transport unavailable' }));
          return;
        }
        const upstream = await fetch(config.baseUrl + req.url, {
          method: req.method,
          headers: { ...(req.headers.authorization && { Authorization: req.headers.authorization }),
            ...(body.length && { 'Content-Type': 'application/json' }) },
          ...(body.length && { body }), signal: AbortSignal.timeout(10_000),
        });
        const text = await upstream.text();
        if (isLog && faults.dropOnce && upstream.status === 200) {
          faults.dropOnce = false;
          faults.offline = true; // Keep retries pending until the next worker process.
          evidence.lost_log_acknowledgements += 1;
          res.destroy();
          return;
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
        res.end(text);
      } catch (_error) {
        if (!res.destroyed) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, data: {}, error: 'verification forwarding failure' }));
        }
      }
    });
    proxy.listen(restoredProxy ? Number(restoredProxy.port) : 0, '127.0.0.1');
    await once(proxy, 'listening');
    proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    evidence.delivery_origin = proxyUrl;
    evidence.credential_store = 'macOS Keychain';
    evidence.api_origin = config.baseUrl;
    const keychainAccount = 'local-' + createHash('sha256').update(proxyUrl + '\n' + registered.user_id).digest('hex');
    assert.match(keychainAccount, /^local-[a-f0-9]{64}$/);
    const currentAccessToken = async () => {
      try {
        const raw = await command('/usr/bin/security', ['find-generic-password', '-s', 'FocusLens.AI.delivery', '-a', keychainAccount, '-w'],
          { env, signal: controller.signal, operation: 'Read only this verification account from Keychain' });
        const pair = JSON.parse(raw);
        assert.ok(typeof pair.access_token === 'string' && pair.access_token.length > 0);
        const claim = JSON.parse(Buffer.from(pair.access_token.split('.')[1], 'base64url').toString('utf8'));
        assert.equal(claim.sub, registered.user_id);
        return pair.access_token;
      } catch (_error) { throw new Error('Verification Keychain credentials could not be confirmed'); }
    };
    if (config.resumeEvidence) token = await currentAccessToken();

    const runWorker = async (action, expectedCode, timeoutMs = 90_000) => {
      const python = process.env.FOCUSLENS_AI_PYTHON || process.env.AI3_PYTHON || process.env.AI2_PYTHON || defaultAiPython();
      const workerEnv = { ...env };
      for (const key of Object.keys(workerEnv)) {
        if (/TOKEN|PASSWORD|JWT_SECRET|DATABASE_URL|REDIS_URL|PG_PASSWORD/.test(key)) delete workerEnv[key];
      }
      const child = spawn(python, ['-B', path.join(__dirname, 'local_ai_verify_worker.py')], {
        cwd: repoRoot, env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
      activeChildren.add(child);
      const events = [];
      let text = '';
      let total = 0;
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > 4 * 1024 * 1024) { child.kill('SIGTERM'); return; }
        text += chunk.toString('utf8');
        let boundary;
        while ((boundary = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, boundary);
          text = text.slice(boundary + 1);
          try {
            const event = publicData(JSON.parse(line));
            events.push(event);
            if (event.event === 'minute_enqueued') console.log(JSON.stringify(event));
          } catch (_error) { /* Ignore private library diagnostics and non-JSON noise. */ }
        }
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      const heartbeat = action === 'measure' ? setInterval(() => console.log(JSON.stringify({
        stage: 'camera_measurement_in_progress', completed_minutes: events.filter(event => event.event === 'minute_enqueued').length,
      })), 30_000) : null;
      const closing = new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('Verification Python worker could not start')));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.stdin.end(JSON.stringify({ action, base_url: proxyUrl, state_dir: stateDirectory,
        secure_store: true, ...(action === 'measure' && { credentials }),
        minutes: 2, camera_index: config.cameraIndex }));
      try {
        const state = await closing;
        evidence.workers.push({ pid: child.pid, action, exit_code: state.code, events });
        assert.equal(state.code, expectedCode, `Local AI ${action} worker returned unexpected exit code`);
        const completed = events.filter(event => event.event === 'worker_result').at(-1);
        assert.ok(completed?.queue, 'Verification worker returns its persisted queue');
        return completed;
      } finally {
        clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        activeChildren.delete(child);
      }
    };
    const readFixture = async sessionId => {
      assert.match(sessionId, UUID, 'Fixture session UUID');
      return JSON.parse(await sql(`SELECT json_build_object(
        'session',(SELECT row_to_json(s) FROM (SELECT id,user_id,started_at AT TIME ZONE 'UTC' AS started_at,
          ended_at AT TIME ZONE 'UTC' AS ended_at,status FROM sessions WHERE id='${sessionId}') s),
        'logs',(SELECT COALESCE(json_agg(l ORDER BY minute_index),'[]'::json) FROM
          (SELECT id,minute_index,client_log_id,measured_at AT TIME ZONE 'UTC' AS measured_at,
            logged_at AT TIME ZONE 'UTC' AS logged_at,gaze_score,blink_score,head_score,focus_score,face_detected,attention_state
           FROM concentration_logs WHERE session_id='${sessionId}') l),
        'report',(SELECT row_to_json(r) FROM (SELECT id,summary_json FROM reports WHERE session_id='${sessionId}') r))`));
    };

    let measurementStart;
    let measurementEnd;
    let measured;
    let elapsedClock;
    if (config.resumeEvidence) {
      const originalWorker = evidence.workers.find(worker => worker.action === 'measure');
      const startReceipt = originalWorker.events.find(event => event.event === 'session_started');
      measured = originalWorker.events.filter(event => event.event === 'worker_result').at(-1);
      assert.ok(measured?.queue?.rows?.length === 2, 'Saved measurement retains two durable camera logs');
      measurementStart = Date.parse(startReceipt.started_at);
      measurementEnd = Date.parse(measured.queue.rows.at(-1).payload.measured_at);
      elapsedClock = 'last_measurement_utc_minus_original_server_started_at';
      progress('reuse_completed_camera_minutes_and_original_api_start_receipt');
    } else {
      progress('measure_two_real_camera_minutes_with_delivery_paused');
      measurementStart = Date.now();
      measured = await runWorker('measure', 3, 210_000);
      measurementEnd = Date.now();
      elapsedClock = 'local_wall_clock_invocation_elapsed';
    }
    const queued = measured.queue.rows;
    assert.equal(queued.length, 2, 'Two full valid camera minutes must be durable');
    assert.ok(queued.every(row => row.status === 'pending'), 'Both camera logs remain pending during transport outage');
    assert.ok(queued.every(row => row.session_id === queued[0].session_id), 'One ordinary server session is used');
    const sessionId = queued[0].session_id;
    evidence.session_id = sessionId;
    const measurementWorker = evidence.workers.find(worker => worker.action === 'measure');
    const minuteEvents = measurementWorker.events.filter(event => event.event === 'minute_enqueued');
    assert.equal(minuteEvents.length, 2, 'Each persisted full minute has one event');
    assert.ok(minuteEvents.every(event => event.samples >= 480), 'Each camera minute meets minimum sampling density');
    assert.ok(measurementEnd - measurementStart >= 120_000, 'Camera windows use actual elapsed time');
    let database = await readFixture(sessionId);
    assert.equal(database.session.user_id, registered.user_id, 'Session belongs to the authenticated fixture account');
    assert.equal(database.session.status, 'IN_PROGRESS', 'Offline logs prevent premature session completion');
    if (!evidence.lost_log_acknowledgements) {
      assert.equal(database.logs.length, 0, 'Proxy outage never changes the real server');
    }
    const originalStartedAt = Date.parse(database.session.started_at);
    const startReceipt = measurementWorker.events.find(event => event.event === 'session_started');
    assert.equal(originalStartedAt, Date.parse(startReceipt.started_at),
      'Database UTC start time matches the original API start receipt without backdating');
    if (!config.resumeEvidence) {
      assert.ok(originalStartedAt >= measurementStart - 5000 && originalStartedAt <= measurementEnd,
        'Session was started during the real measurement invocation');
    }
    assert.equal(Date.parse(queued[1].payload.measured_at) - Date.parse(queued[0].payload.measured_at), 60_000,
      'Consecutive measured windows retain exact one-minute spacing');
    evidence.measurement = { elapsed_ms: measurementEnd - measurementStart,
      elapsed_clock: elapsedClock, started_at: database.session.started_at, minutes: minuteEvents,
      database_timestamps: 'PostgreSQL timestamp interpreted as UTC with AT TIME ZONE',
      original_start_receipt_matches_database: true };

    progress('restart_delivery_process_and_lose_one_committed_acknowledgement');
    if (!evidence.lost_log_acknowledgements) {
      faults.offline = false;
      faults.dropOnce = true;
      const uncertain = await runWorker('finish', 3);
      assert.ok(uncertain.queue.rows.some(row => row.status === 'pending'), 'Unknown commit remains recoverable in the outbox');
    }
    assert.equal(evidence.lost_log_acknowledgements, 1, 'One log reached PostgreSQL but its receipt was lost');
    database = await readFixture(sessionId);
    assert.equal(database.session.status, 'IN_PROGRESS', 'Unknown delivery result must not finish the session');
    assert.equal(database.logs.length, 1, 'The dropped receipt belongs to exactly one committed log');

    progress('restart_again_replay_identical_logs_and_finish_report');
    faults.offline = false;
    const finished = await runWorker('finish', 0);
    assert.ok(finished.queue.rows.every(row => row.status === 'sent'), 'Every durable log is acknowledged after restart');
    database = await readFixture(sessionId);
    assert.equal(database.session.started_at, evidence.measurement.started_at, 'Original session time is unchanged');
    assert.equal(database.session.status, 'COMPLETED', 'Recovered session finishes normally');
    assert.equal(database.logs.length, 2, 'Replaying a committed log does not create duplicates');
    assert.equal(new Set(database.logs.map(row => row.client_log_id)).size, 2, 'Client log IDs remain unique');
    const expectedIndices = [];
    for (let index = 0; index < queued.length; index += 1) {
      const payload = queued[index].payload;
      const row = database.logs[index];
      assert.match(payload.client_log_id, UUID);
      assert.equal(row.client_log_id, payload.client_log_id, 'Database keeps the original durable client ID');
      assert.equal(Date.parse(row.measured_at), Date.parse(payload.measured_at), 'Database keeps the actual measurement timestamp');
      const minuteIndex = Math.floor((Date.parse(payload.measured_at) - originalStartedAt) / 60_000);
      expectedIndices.push(minuteIndex);
      assert.equal(row.minute_index, minuteIndex, 'Server minute index uses the original measurement time');
      assert.ok(Date.parse(row.logged_at) >= Date.parse(row.measured_at), 'Delayed logs retain later receipt times');
      for (const [field, column] of Object.entries({ gaze: 'gaze_score', blink: 'blink_score', head: 'head_score', total: 'focus_score' })) {
        assert.equal(row[column], payload[field], 'Persisted score equals the camera aggregate');
      }
      assert.equal(row.face_detected, payload.face_detected);
      assert.equal(row.attention_state, scoreState(payload.total));
    }
    assert.deepEqual(expectedIndices, [1, 2], 'No session backdating is needed for two real minutes');
    token = await currentAccessToken(); // A finish worker may have rotated expired credentials.
    const report = await request(`/api/reports/${sessionId}`, { token });
    const session = await request(`/api/sessions/${sessionId}`, { token });
    assert.equal(report.timeline.length, 2);
    assert.deepEqual(report.timeline, session.timeline, 'Session and report timelines agree');
    assert.deepEqual(report.summary_json, database.report.summary_json, 'API and stored report summary agree');
    const summary = report.summary_json;
    assert.equal(summary.total_logs, 2);
    for (const [field, column] of Object.entries({ avg_focus_score: 'total', gaze_avg: 'gaze', blink_avg: 'blink', head_avg: 'head' })) {
      assert.equal(summary[field], round(queued.reduce((sum, row) => sum + row.payload[column], 0) / 2));
    }
    for (const [field, state] of Object.entries({ focused_minutes: 'FOCUSED', normal_minutes: 'NORMAL', distracted_minutes: 'DISTRACTED' })) {
      assert.equal(summary[field], database.logs.filter(row => row.attention_state === state).length);
    }
    assert.equal(summary.duration_seconds, Math.floor((Date.parse(database.session.ended_at) - originalStartedAt) / 1000));
    assert.ok(summary.duration_seconds >= 120);
    const processCount = new Set(evidence.workers.map(worker => worker.pid)).size;
    assert.ok(processCount >= 3, 'Three independent processes reuse the same durable queue');
    result = { result: 'LBE-4 continuous local AI passed', source: 'camera', api_origin: config.baseUrl,
      user_id: registered.user_id, session_id: sessionId, report_id: report.report_id,
      actual_elapsed_ms: measurementEnd - measurementStart, session_backdated: false, virtual_clock: false,
      actual_elapsed_clock: elapsedClock,
      completed_minutes: 2, database_logs: 2, process_restarts: processCount - 1, lost_ack_recovered: true,
      immutable_payloads_preserved: true, scores_and_report_match: true, summary,
      credential_store: 'macOS Keychain', credentials_reused_after_restart: true,
      evidence_path: path.join(directory, 'evidence.json') };
    evidence.database = database;
    evidence.report = report;
    evidence.outbox = finished.queue;
    evidence.report_sha256 = digest(report);
    await command('/usr/bin/security', ['delete-generic-password', '-s', 'FocusLens.AI.delivery', '-a', keychainAccount],
      { env, signal: controller.signal, operation: 'Remove only this verification account from Keychain' });
    result.verification_keychain_item_removed = true;
    evidence.result = result;
  } catch (error) {
    result = { result: 'LBE-4 continuous local AI failed', stage, error: error.message,
      ...(directory && { evidence_path: path.join(directory, 'evidence.json') }) };
    evidence.result = result;
    process.exitCode = 1;
  } finally {
    for (const child of activeChildren) child.kill('SIGTERM');
    if (proxy) {
      proxy.closeAllConnections?.();
      await new Promise(resolve => proxy.close(resolve));
    }
    if (directory) {
      const temporaryEvidence = path.join(directory, `.evidence-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporaryEvidence, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(publicData(evidence), null, 2) + '\n');
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temporaryEvidence, path.join(directory, 'evidence.json'));
      } finally { await fs.unlink(temporaryEvidence).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ result: 'LBE-4 continuous local AI failed', error: 'Verification setup or cleanup failed' }));
  process.exitCode = 1;
});

module.exports = { options, publicData };
