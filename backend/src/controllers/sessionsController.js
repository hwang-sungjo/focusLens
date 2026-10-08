// src/controllers/sessionsController.js
// ERD 원칙: sessions에 파생 평균/기간 저장 금지 — 원본과 Roll-up tier에서 조회 시 계산
const prisma = require('../models/prismaClient');
const { calcFocusScore, getAttentionState } = require('../utils/focusScore');
const {
  calculateDurationSeconds,
  buildSessionSummary,
} = require('../utils/sessionMetrics');
const { getSessionMetricMap, getSessionTimeline } = require('../services/sessionStats');
const { getPagination } = require('../utils/pagination');
const { createError } = require('../middleware/errorHandler');

const round = (value) => Math.round(value * 100) / 100;
const MINUTE_MS = 60_000;
const MAX_FUTURE_MEASUREMENT_MS = 5 * MINUTE_MS;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const runSerializableTransaction = async (operation, maxAttempts = 3) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (err.code !== 'P2034' || attempt === maxAttempts) throw err;
    }
  }
  throw new Error('트랜잭션을 완료하지 못했습니다.');
};

const calculateMinuteIndex = (startedAt, receivedAt) => {
  const elapsedMs = receivedAt.getTime() - startedAt.getTime();
  if (elapsedMs < MINUTE_MS) {
    throw createError('첫 1분 측정 구간이 아직 완료되지 않았습니다.', 400);
  }
  return Math.floor(elapsedMs / MINUTE_MS);
};

const serializeSession = (session, metric) => ({
  session_id: session.id,
  started_at: session.started_at,
  ended_at: session.ended_at,
  status: session.status,
  avg_focus_score: metric?.avg_focus_score ?? null,
  duration_seconds: calculateDurationSeconds(session.started_at, session.ended_at),
});

const logSelect = {
  id: true,
  minute_index: true,
  logged_at: true,
  client_log_id: true,
  measured_at: true,
  gaze_score: true,
  blink_score: true,
  head_score: true,
  focus_score: true,
  attention_state: true,
  face_detected: true,
};

const serializeLogResponse = (log) => ({
  log_id: log.id,
  minute_index: log.minute_index,
  logged_at: log.logged_at,
  focus_score: log.focus_score,
  attention_state: log.attention_state,
  face_detected: log.face_detected,
});

const serializeLogV2Response = (log) => ({
  ...serializeLogResponse(log),
  client_log_id: log.client_log_id,
  measured_at: log.measured_at,
});

const hasSameLogContent = (log, values) =>
  log.gaze_score === values.gaze
  && log.blink_score === values.blink
  && log.head_score === values.head
  && log.focus_score === values.total
  && log.face_detected === values.faceDetected;

const hasSameV2LogContent = (log, values, clientLogId, measuredAt) => (
  hasSameLogContent(log, values)
  && log.client_log_id === clientLogId
  && log.measured_at instanceof Date
  && log.measured_at.getTime() === measuredAt.getTime()
);

const normalizeScorePayload = (body) => {
  const {
    gaze: gazeValue,
    blink: blinkValue,
    head: headValue,
    total: totalValue,
    face_detected: faceDetected,
  } = body;

  if (typeof faceDetected !== 'boolean') {
    throw createError('face_detected는 필수 boolean이어야 합니다.', 400);
  }
  if (!faceDetected && [gazeValue, blinkValue, headValue, totalValue].some((value) => value !== 0)) {
    throw createError('face_detected가 false이면 모든 점수는 0이어야 합니다.', 400);
  }

  const gaze = round(gazeValue);
  const blink = round(blinkValue);
  const head = round(headValue);
  const requestedTotal = round(totalValue);
  const calculatedTotal = calcFocusScore(gaze, blink, head);
  if (Math.abs(calculatedTotal - requestedTotal) > 0.01) {
    throw createError(`total은 가중 합산값 ${calculatedTotal}과 일치해야 합니다.`, 400);
  }

  return {
    gaze,
    blink,
    head,
    total: calculatedTotal,
    faceDetected,
    attentionState: getAttentionState(calculatedTotal),
  };
};

/** POST /api/sessions/start */
const startSession = async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const activeSession = await prisma.sessions.findFirst({
      where: { user_id: userId, status: 'IN_PROGRESS' },
      select: { id: true },
    });
    if (activeSession) return next(createError('이미 진행 중인 세션이 있습니다.', 409));

    let session;
    try {
      session = await prisma.sessions.create({
        data: {
          user_id: userId,
          started_at: new Date(),
          status: 'IN_PROGRESS',
        },
        select: { id: true, started_at: true, status: true },
      });
    } catch (err) {
      // 사전 조회 이후 동시에 시작된 요청은 DB 부분 유니크 인덱스가 차단한다.
      if (err.code === 'P2002') {
        return next(createError('이미 진행 중인 세션이 있습니다.', 409));
      }
      throw err;
    }
    return res.status(201).json({
      success: true,
      data: { session_id: session.id, started_at: session.started_at, status: session.status },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/sessions/:id/log — 집중도 로그 저장 */
const logConcentration = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionId } = req.params;
    const normalized = normalizeScorePayload(req.body);
    const {
      gaze, blink, head, total: calculatedTotal, faceDetected, attentionState,
    } = normalized;

    const receivedAt = new Date();
    const normalizedValues = {
      gaze,
      blink,
      head,
      total: calculatedTotal,
      faceDetected,
    };

    let minuteIndex;
    let log;
    try {
      log = await runSerializableTransaction(async (tx) => {
        const session = await tx.sessions.findUnique({ where: { id: sessionId } });
        if (!session) throw createError('세션을 찾을 수 없습니다.', 404);
        if (session.user_id !== userId) throw createError('세션에 대한 권한이 없습니다.', 403);
        if (session.status !== 'IN_PROGRESS') {
          throw createError('종료된 세션에는 로그를 추가할 수 없습니다.', 409);
        }

        minuteIndex = calculateMinuteIndex(session.started_at, receivedAt);
        const uniqueWhere = {
          session_id_minute_index: { session_id: sessionId, minute_index: minuteIndex },
        };
        const existingLog = await tx.concentration_logs.findUnique({
          where: uniqueWhere,
          select: logSelect,
        });
        if (existingLog) {
          if (!hasSameLogContent(existingLog, normalizedValues)) {
            throw createError('같은 분 구간에 다른 로그가 이미 존재합니다.', 409);
          }
          return existingLog;
        }

        return tx.concentration_logs.create({
          data: {
            session_id: sessionId,
            minute_index: minuteIndex,
            logged_at: receivedAt,
            gaze_score: gaze,
            blink_score: blink,
            head_score: head,
            focus_score: calculatedTotal,
            attention_state: attentionState,
            face_detected: faceDetected,
          },
          select: logSelect,
        });
      });
    } catch (err) {
      if (err.code !== 'P2002' || minuteIndex === undefined) throw err;

      const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
      if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
      if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));
      if (session.status !== 'IN_PROGRESS') {
        return next(createError('종료된 세션에는 로그를 추가할 수 없습니다.', 409));
      }

      const concurrentLog = await prisma.concentration_logs.findUnique({
        where: {
          session_id_minute_index: { session_id: sessionId, minute_index: minuteIndex },
        },
        select: logSelect,
      });
      if (!concurrentLog || !hasSameLogContent(concurrentLog, normalizedValues)) {
        return next(createError('같은 분 구간에 다른 로그가 이미 존재합니다.', 409));
      }
      log = concurrentLog;
    }

    return res.status(200).json({
      success: true,
      data: serializeLogResponse(log),
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v2/sessions/:id/log — 측정 시각과 클라이언트 ID 기반 집중도 로그 저장 */
const logConcentrationV2 = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionId } = req.params;
    const clientLogIdValue = req.body.client_log_id;
    const measuredAtValue = req.body.measured_at;

    if (typeof clientLogIdValue !== 'string' || !UUID_V4_PATTERN.test(clientLogIdValue)) {
      return next(createError('client_log_id는 UUID v4여야 합니다.', 400));
    }
    if (typeof measuredAtValue !== 'string' || !UTC_RFC3339_PATTERN.test(measuredAtValue)) {
      return next(createError('measured_at은 UTC RFC 3339 형식이어야 합니다.', 400));
    }

    const measuredAt = new Date(measuredAtValue);
    if (Number.isNaN(measuredAt.getTime())) {
      return next(createError('measured_at은 UTC RFC 3339 형식이어야 합니다.', 400));
    }

    const receivedAt = new Date();
    if (measuredAt.getTime() > receivedAt.getTime() + MAX_FUTURE_MEASUREMENT_MS) {
      return next(createError('measured_at은 서버 시각보다 5분을 초과해 미래일 수 없습니다.', 400));
    }

    const clientLogId = clientLogIdValue.toLowerCase();
    const normalized = normalizeScorePayload(req.body);
    const {
      gaze, blink, head, total, faceDetected, attentionState,
    } = normalized;

    const findByClientId = (db) => db.concentration_logs.findUnique({
      where: {
        session_id_client_log_id: {
          session_id: sessionId,
          client_log_id: clientLogId,
        },
      },
      select: logSelect,
    });
    const findByMinute = (db, minuteIndex) => db.concentration_logs.findUnique({
      where: {
        session_id_minute_index: { session_id: sessionId, minute_index: minuteIndex },
      },
      select: logSelect,
    });

    let minuteIndex;
    let log;
    try {
      log = await runSerializableTransaction(async (tx) => {
        const session = await tx.sessions.findUnique({ where: { id: sessionId } });
        if (!session) throw createError('세션을 찾을 수 없습니다.', 404);
        if (session.user_id !== userId) throw createError('세션에 대한 권한이 없습니다.', 403);
        if (session.status !== 'IN_PROGRESS') {
          throw createError('종료된 세션에는 로그를 추가할 수 없습니다.', 409);
        }

        minuteIndex = calculateMinuteIndex(session.started_at, measuredAt);

        const existingByClientId = await findByClientId(tx);
        if (existingByClientId) {
          if (!hasSameV2LogContent(existingByClientId, normalized, clientLogId, measuredAt)) {
            throw createError('같은 client_log_id에 다른 로그가 이미 존재합니다.', 409);
          }
          return existingByClientId;
        }

        const existingByMinute = await findByMinute(tx, minuteIndex);
        if (existingByMinute) {
          throw createError('같은 분 구간에 다른 로그가 이미 존재합니다.', 409);
        }

        return tx.concentration_logs.create({
          data: {
            session_id: sessionId,
            minute_index: minuteIndex,
            logged_at: receivedAt,
            client_log_id: clientLogId,
            measured_at: measuredAt,
            gaze_score: gaze,
            blink_score: blink,
            head_score: head,
            focus_score: total,
            attention_state: attentionState,
            face_detected: faceDetected,
          },
          select: logSelect,
        });
      });
    } catch (err) {
      if (err.code !== 'P2002' || minuteIndex === undefined) throw err;

      const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
      if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
      if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));
      if (session.status !== 'IN_PROGRESS') {
        return next(createError('종료된 세션에는 로그를 추가할 수 없습니다.', 409));
      }

      const concurrentByClientId = await findByClientId(prisma);
      if (concurrentByClientId) {
        if (!hasSameV2LogContent(concurrentByClientId, normalized, clientLogId, measuredAt)) {
          return next(createError('같은 client_log_id에 다른 로그가 이미 존재합니다.', 409));
        }
        log = concurrentByClientId;
      } else {
        const concurrentByMinute = await findByMinute(prisma, minuteIndex);
        if (!concurrentByMinute) throw err;
        return next(createError('같은 분 구간에 다른 로그가 이미 존재합니다.', 409));
      }
    }

    return res.status(200).json({
      success: true,
      data: serializeLogV2Response(log),
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/sessions/:id/end */
const endSession = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionId } = req.params;

    const { updatedSession, report, summaryJson } = await runSerializableTransaction(async (tx) => {
      const session = await tx.sessions.findUnique({ where: { id: sessionId } });
      if (!session) throw createError('세션을 찾을 수 없습니다.', 404);
      if (session.user_id !== userId) throw createError('세션에 대한 권한이 없습니다.', 403);
      if (session.status !== 'IN_PROGRESS') throw createError('이미 종료된 세션입니다.', 409);

      const logs = await tx.concentration_logs.findMany({
        where: { session_id: sessionId },
        select: {
          gaze_score: true,
          blink_score: true,
          head_score: true,
          focus_score: true,
          attention_state: true,
        },
      });
      const endedAt = new Date();
      const summary = buildSessionSummary(logs, session.started_at, endedAt);

      const completedSession = await tx.sessions.update({
        where: { id: sessionId },
        data: { status: 'COMPLETED', ended_at: endedAt },
        select: { id: true, ended_at: true, status: true },
      });
      const createdReport = await tx.reports.create({
        data: { session_id: sessionId, summary_json: summary },
        select: { id: true },
      });
      return { updatedSession: completedSession, report: createdReport, summaryJson: summary };
    });

    return res.status(200).json({
      success: true,
      data: {
        session_id: updatedSession.id,
        report_id: report.id,
        ended_at: updatedSession.ended_at,
        status: updatedSession.status,
        summary: summaryJson,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/sessions */
const getSessions = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { page, limit, skip } = getPagination(req.query);
    const where = { user_id: userId, ...(req.query.status && { status: req.query.status }) };

    const [rows, total] = await prisma.$transaction([
      prisma.sessions.findMany({
        where,
        orderBy: [{ started_at: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.sessions.count({ where }),
    ]);

    const metricMap = await getSessionMetricMap(rows.map((session) => session.id));

    return res.status(200).json({
      success: true,
      data: {
        sessions: rows.map((session) => serializeSession(session, metricMap.get(session.id))),
        pagination: { page, limit, total },
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/sessions/:id — 분 단위 타임라인 포함 */
const getSession = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionId } = req.params;

    const session = await prisma.sessions.findUnique({ where: { id: sessionId } });

    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));

    const [metricMap, timeline] = await Promise.all([
      getSessionMetricMap([sessionId]),
      getSessionTimeline(sessionId),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        ...serializeSession(session, metricMap.get(sessionId)),
        timeline,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  startSession,
  logConcentration,
  logConcentrationV2,
  endSession,
  getSessions,
  getSession,
};
