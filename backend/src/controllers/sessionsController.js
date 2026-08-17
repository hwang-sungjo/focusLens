// src/controllers/sessionsController.js
// ERD 원칙: sessions에 avg_focus_score/duration_seconds 저장 금지 — 조회 시 concentration_logs에서 계산
const prisma = require('../models/prismaClient');
const { acquireLogRateLimit, releaseLogRateLimit } = require('../services/redis');
const { calcFocusScore, getAttentionState } = require('../utils/focusScore');
const { createError } = require('../middleware/errorHandler');

const round = (value) => Math.round(value * 100) / 100;

const calculateDurationSeconds = (startedAt, endedAt) => {
  if (!endedAt) return null;
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
};

const calculateAverage = (logs, field = 'focus_score') => {
  if (!logs.length) return null;
  return round(logs.reduce((sum, log) => sum + log[field], 0) / logs.length);
};

const buildSummaryJson = (logs, startedAt, endedAt) => ({
  avg_focus_score: calculateAverage(logs),
  duration_seconds: calculateDurationSeconds(startedAt, endedAt),
  gaze_avg: calculateAverage(logs, 'gaze_score'),
  blink_avg: calculateAverage(logs, 'blink_score'),
  head_avg: calculateAverage(logs, 'head_score'),
  focused_minutes: logs.filter((log) => log.attention_state === 'FOCUSED').length,
  normal_minutes: logs.filter((log) => log.attention_state === 'NORMAL').length,
  distracted_minutes: logs.filter((log) => log.attention_state === 'DISTRACTED').length,
  total_logs: logs.length,
});

const serializeSession = (session) => ({
  session_id: session.id,
  started_at: session.started_at,
  ended_at: session.ended_at,
  status: session.status,
  avg_focus_score: calculateAverage(session.concentration_logs),
  duration_seconds: calculateDurationSeconds(session.started_at, session.ended_at),
});

/** POST /api/sessions/start */
const startSession = async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const activeSession = await prisma.sessions.findFirst({
      where: { user_id: userId, status: 'IN_PROGRESS' },
      select: { id: true },
    });
    if (activeSession) return next(createError('이미 진행 중인 세션이 있습니다.', 409));

    const session = await prisma.sessions.create({
      data: {
        user_id: userId,
        started_at: new Date(),
        status: 'IN_PROGRESS',
      },
      select: { id: true, started_at: true, status: true },
    });
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
    const { gaze, blink, head, total, face_detected = true } = req.body;

    // ② session_id 소유자 = JWT sub 매칭 검증
    const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));
    if (session.status !== 'IN_PROGRESS') return next(createError('종료된 세션에는 로그를 추가할 수 없습니다.', 409));

    const calculatedTotal = calcFocusScore(gaze, blink, head);
    if (Math.abs(calculatedTotal - total) > 0.01) {
      return next(createError(`total은 가중 합산값 ${calculatedTotal}과 일치해야 합니다.`, 400));
    }

    // Redis SET NX로 동시 요청도 원자적으로 차단한다.
    const acquired = await acquireLogRateLimit(sessionId, 60);
    if (!acquired) return next(createError('1분 미만 중복 로그 전송입니다.', 400));

    const attention_state = getAttentionState(calculatedTotal);

    let log;
    try {
      log = await prisma.concentration_logs.create({
        data: {
          session_id: sessionId,
          logged_at: new Date(),
          gaze_score: gaze,
          blink_score: blink,
          head_score: head,
          focus_score: calculatedTotal,
          attention_state,
          face_detected,
        },
        select: { id: true, logged_at: true, focus_score: true, attention_state: true, face_detected: true },
      });
    } catch (err) {
      await releaseLogRateLimit(sessionId).catch(() => {});
      throw err;
    }

    return res.status(200).json({
      success: true,
      data: {
        log_id: log.id,
        logged_at: log.logged_at,
        focus_score: log.focus_score,
        attention_state: log.attention_state,
        face_detected: log.face_detected,
      },
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

    const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));
    if (session.status !== 'IN_PROGRESS') return next(createError('이미 종료된 세션입니다.', 409));

    const logs = await prisma.concentration_logs.findMany({
      where: { session_id: sessionId },
      select: {
        gaze_score: true, blink_score: true, head_score: true, focus_score: true, attention_state: true,
      },
    });

    const endedAt = new Date();
    const summaryJson = buildSummaryJson(logs, session.started_at, endedAt);

    const [updatedSession, report] = await prisma.$transaction([
      prisma.sessions.update({
        where: { id: sessionId },
        data: { status: 'COMPLETED', ended_at: endedAt },
        select: { id: true, ended_at: true, status: true },
      }),
      prisma.reports.create({
        data: { session_id: sessionId, summary_json: summaryJson },
        select: { id: true },
      }),
    ]);

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
    const page = Number.parseInt(req.query.page || '1', 10);
    const limit = Number.parseInt(req.query.limit || '20', 10);
    const where = { user_id: userId, ...(req.query.status && { status: req.query.status }) };

    const [rows, total] = await prisma.$transaction([
      prisma.sessions.findMany({
        where,
        orderBy: { started_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { concentration_logs: { select: { focus_score: true } } },
      }),
      prisma.sessions.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: { sessions: rows.map(serializeSession), pagination: { page, limit, total } },
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

    const session = await prisma.sessions.findUnique({
      where: { id: sessionId },
      include: {
        concentration_logs: {
          orderBy: { logged_at: 'asc' },
          select: { logged_at: true, gaze_score: true, blink_score: true, head_score: true, focus_score: true, attention_state: true, face_detected: true },
        },
      },
    });

    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));

    return res.status(200).json({
      success: true,
      data: {
        ...serializeSession(session),
        timeline: session.concentration_logs.map((log) => ({
          logged_at: log.logged_at,
          gaze_score: log.gaze_score,
          blink_score: log.blink_score,
          head_score: log.head_score,
          focus_score: log.focus_score,
          attention_state: log.attention_state,
          face_detected: log.face_detected,
        })),
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { startSession, logConcentration, endSession, getSessions, getSession };
