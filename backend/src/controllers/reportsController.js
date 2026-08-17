// src/controllers/reportsController.js
const prisma = require('../models/prismaClient');
const { calcSessionAvgScore } = require('../utils/focusScore');
const { createError } = require('../middleware/errorHandler');

const toDateKey = (date) => date.toISOString().slice(0, 10);

const durationSeconds = (session) => {
  if (!session.ended_at) return 0;
  return Math.max(0, Math.floor((session.ended_at.getTime() - session.started_at.getTime()) / 1000));
};

const parseEndDate = (value) => {
  if (!value) return new Date();
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || toDateKey(date) !== value) return null;
  return date;
};

const buildPeriodReport = async (userId, endDateValue, days) => {
  const end = parseEndDate(endDateValue);
  if (!end) throw createError('end_date 형식이 올바르지 않습니다.', 400);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);

  const sessions = await prisma.sessions.findMany({
    where: { user_id: userId, started_at: { gte: start, lte: end } },
    include: {
      concentration_logs: {
        where: { logged_at: { gte: start, lte: end } },
        select: { focus_score: true, logged_at: true },
      },
    },
  });

  const buckets = new Map();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    buckets.set(toDateKey(date), { scores: [], session_count: 0, total_study_seconds: 0 });
  }

  for (const session of sessions) {
    const sessionBucket = buckets.get(toDateKey(session.started_at));
    if (sessionBucket) {
      sessionBucket.session_count += 1;
      sessionBucket.total_study_seconds += durationSeconds(session);
    }

    for (const log of session.concentration_logs) {
      const logBucket = buckets.get(toDateKey(log.logged_at));
      if (logBucket) logBucket.scores.push(log.focus_score);
    }
  }

  const allScores = [];
  const dailySummaries = Array.from(buckets, ([date, bucket]) => {
    allScores.push(...bucket.scores);
    return {
      date,
      session_count: bucket.session_count,
      total_study_seconds: bucket.total_study_seconds,
      avg_focus_score: calcSessionAvgScore(bucket.scores.map((focus_score) => ({ focus_score }))),
    };
  });

  return {
    period: { start_date: toDateKey(start), end_date: toDateKey(end) },
    daily_summaries: dailySummaries,
    avg_focus_score: calcSessionAvgScore(allScores.map((focus_score) => ({ focus_score }))),
    total_study_seconds: dailySummaries.reduce((sum, day) => sum + day.total_study_seconds, 0),
  };
};

/** GET /api/reports/:session_id */
const getReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { session_id } = req.params;

    const session = await prisma.sessions.findUnique({
      where: { id: session_id },
      include: {
        report: true,
        concentration_logs: {
          orderBy: { logged_at: 'asc' },
          select: {
            logged_at: true,
            gaze_score: true,
            blink_score: true,
            head_score: true,
            focus_score: true,
            attention_state: true,
          },
        },
      },
    });

    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('리포트에 대한 권한이 없습니다.', 403));
    if (!session.report) return next(createError('리포트가 아직 생성되지 않았습니다.', 404));

    return res.status(200).json({
      success: true,
      data: {
        report_id: session.report.id,
        session_id: session.id,
        summary_json: session.report.summary_json,
        timeline: session.concentration_logs,
        created_at: session.report.created_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/weekly — 최근 7일 일별 평균 집중도 */
const getWeeklyReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const report = await buildPeriodReport(userId, req.query.end_date, 7);

    return res.status(200).json({
      success: true,
      data: {
        period: report.period,
        daily_summaries: report.daily_summaries,
        weekly_avg_focus_score: report.avg_focus_score,
        weekly_total_study_seconds: report.total_study_seconds,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/monthly */
const getMonthlyReport = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const report = await buildPeriodReport(userId, req.query.end_date, 30);

    return res.status(200).json({
      success: true,
      data: {
        period: report.period,
        daily_summaries: report.daily_summaries,
        monthly_avg_focus_score: report.avg_focus_score,
        monthly_total_study_seconds: report.total_study_seconds,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getReport, getWeeklyReport, getMonthlyReport };
