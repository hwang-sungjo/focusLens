// src/controllers/reportsController.js
const prisma = require('../models/prismaClient');
const { calcSessionAvgScore } = require('../utils/focusScore');
const { createError } = require('../middleware/errorHandler');

/** GET /api/reports/:session_id */
const getReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { session_id } = req.params;

    const report = await prisma.reports.findUnique({
      where: { session_id },
      include: {
        sessions: {
          select: { user_id: true, started_at: true, ended_at: true, status: true },
        },
      },
    });

    if (!report) return next(createError('리포트를 찾을 수 없습니다.', 404));
    if (report.sessions.user_id !== userId) return next(createError('리포트에 대한 권한이 없습니다.', 403));

    return res.status(200).json({ success: true, data: { report }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/weekly — 최근 7일 일별 평균 집중도 */
const getWeeklyReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);

    // concentration_logs에서 직접 집계 (sessions에 avg 저장 금지 원칙 준수)
    const logs = await prisma.concentration_logs.findMany({
      where: {
        sessions: { user_id: userId, started_at: { gte: since } },
      },
      select: { focus_score: true, logged_at: true },
      orderBy: { logged_at: 'asc' },
    });

    // 일별 그룹핑
    const daily = {};
    logs.forEach(({ focus_score, logged_at }) => {
      const day = logged_at.toISOString().split('T')[0];
      if (!daily[day]) daily[day] = [];
      daily[day].push(focus_score);
    });

    const summary = Object.entries(daily).map(([date, scores]) => ({
      date,
      avg_focus_score: calcSessionAvgScore(scores.map((s) => ({ focus_score: s }))),
      log_count: scores.length,
    }));

    return res.status(200).json({ success: true, data: { weekly: summary }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/monthly */
const getMonthlyReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const logs = await prisma.concentration_logs.findMany({
      where: { sessions: { user_id: userId, started_at: { gte: since } } },
      select: { focus_score: true, logged_at: true },
      orderBy: { logged_at: 'asc' },
    });

    const daily = {};
    logs.forEach(({ focus_score, logged_at }) => {
      const day = logged_at.toISOString().split('T')[0];
      if (!daily[day]) daily[day] = [];
      daily[day].push(focus_score);
    });

    const summary = Object.entries(daily).map(([date, scores]) => ({
      date,
      avg_focus_score: calcSessionAvgScore(scores.map((s) => ({ focus_score: s }))),
      log_count: scores.length,
    }));

    return res.status(200).json({ success: true, data: { monthly: summary }, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getReport, getWeeklyReport, getMonthlyReport };
