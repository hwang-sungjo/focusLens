// src/controllers/sessionsController.js
// ERD 원칙: sessions에 avg_focus_score/duration_seconds 저장 금지 — 조회 시 concentration_logs에서 계산
const prisma = require('../models/prismaClient');
const { setLastLogTime, getLastLogTime } = require('../services/redis');
const { calcFocusScore, getAttentionState } = require('../utils/focusScore');
const { createError } = require('../middleware/errorHandler');

/** POST /api/sessions/start */
const startSession = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const session = await prisma.sessions.create({
      data: {
        user_id: userId,
        started_at: new Date(),
        status: 'ACTIVE',
      },
      select: { id: true, started_at: true, status: true },
    });
    return res.status(201).json({ success: true, data: { session }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/sessions/:id/log — 집중도 로그 저장 */
const logConcentration = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionId } = req.params;
    const { gaze_score, blink_score, head_score, face_detected } = req.body;

    // ② session_id 소유자 = JWT sub 매칭 검증
    const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));
    if (session.status !== 'ACTIVE') return next(createError('이미 종료된 세션입니다.', 400));

    // ③ 1분 미만 중복 전송 차단
    const lastTime = await getLastLogTime(sessionId).catch(() => null);
    if (lastTime && Date.now() - lastTime < 60 * 1000) {
      return res.status(400).json({ success: false, data: {}, error: '1분 이내 중복 로그 전송은 허용되지 않습니다.' });
    }

    const focus_score = calcFocusScore(gaze_score, blink_score, head_score);
    const attention_state = getAttentionState(focus_score);

    const log = await prisma.concentration_logs.create({
      data: {
        session_id: sessionId,
        logged_at: new Date(),
        gaze_score,
        blink_score,
        head_score,
        focus_score,
        attention_state,
        face_detected,
      },
      select: { id: true, logged_at: true, focus_score: true, attention_state: true },
    });

    await setLastLogTime(sessionId).catch(() => {});
    return res.status(200).json({ success: true, data: { log }, error: '' });
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
    if (session.status !== 'ACTIVE') return next(createError('이미 종료된 세션입니다.', 400));

    const logs = await prisma.concentration_logs.findMany({
      where: { session_id: sessionId },
      select: {
        gaze_score: true, blink_score: true, head_score: true, focus_score: true, attention_state: true,
      },
    });

    // 리포트 summary_json 생성 (파생값 — sessions 테이블에 저장하지 않음)
    const summaryJson = buildSummaryJson(logs);

    const [updatedSession, report] = await prisma.$transaction([
      prisma.sessions.update({
        where: { id: sessionId },
        data: { status: 'COMPLETED', ended_at: new Date() },
        select: { id: true, ended_at: true, status: true },
      }),
      prisma.reports.create({
        data: { session_id: sessionId, summary_json: summaryJson },
        select: { id: true },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: { session: updatedSession, report_id: report.id },
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
    const sessions = await prisma.sessions.findMany({
      where: { user_id: userId },
      orderBy: { started_at: 'desc' },
      select: { id: true, started_at: true, ended_at: true, status: true, created_at: true },
    });
    return res.status(200).json({ success: true, data: { sessions }, error: '' });
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

    return res.status(200).json({ success: true, data: { session }, error: '' });
  } catch (err) {
    next(err);
  }
};

// --- 내부 헬퍼 ---
const buildSummaryJson = (logs) => {
  if (!logs.length) return { avg_focus_score: null, total_logs: 0 };

  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    total_logs: logs.length,
    avg_focus_score: Math.round(avg(logs.map((l) => l.focus_score)) * 100) / 100,
    avg_gaze_score: Math.round(avg(logs.map((l) => l.gaze_score)) * 100) / 100,
    avg_blink_score: Math.round(avg(logs.map((l) => l.blink_score)) * 100) / 100,
    avg_head_score: Math.round(avg(logs.map((l) => l.head_score)) * 100) / 100,
    attention_distribution: {
      FOCUSED: logs.filter((l) => l.attention_state === 'FOCUSED').length,
      NORMAL: logs.filter((l) => l.attention_state === 'NORMAL').length,
      DISTRACTED: logs.filter((l) => l.attention_state === 'DISTRACTED').length,
    },
  };
};

module.exports = { startSession, logConcentration, endSession, getSessions, getSession };
