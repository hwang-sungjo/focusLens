// src/controllers/reportsController.js
const prisma = require('../models/prismaClient');
const { calculateDurationSeconds } = require('../utils/sessionMetrics');
const { getSessionMetricMap, getSessionTimeline } = require('../services/sessionStats');
const { createError } = require('../middleware/errorHandler');

const toDateKey = (date) => date.toISOString().slice(0, 10);
const weightedAverage = (sum, count) => (count > 0 ? Math.round((sum / count) * 100) / 100 : null);

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
    where: {
      user_id: userId,
      status: 'COMPLETED',
      ended_at: { not: null },
      started_at: { gte: start, lte: end },
    },
  });
  const metricMap = await getSessionMetricMap(sessions.map((session) => session.id));

  const buckets = new Map();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    buckets.set(toDateKey(date), {
      focus_score_sum: 0,
      log_count: 0,
      session_count: 0,
      total_study_seconds: 0,
    });
  }

  for (const session of sessions) {
    const sessionBucket = buckets.get(toDateKey(session.started_at));
    if (sessionBucket) {
      sessionBucket.session_count += 1;
      sessionBucket.total_study_seconds += calculateDurationSeconds(
        session.started_at,
        session.ended_at,
      ) ?? 0;
      const metric = metricMap.get(session.id);
      sessionBucket.focus_score_sum += metric?.focus_score_sum ?? 0;
      sessionBucket.log_count += metric?.log_count ?? 0;
    }
  }

  let totalFocusScoreSum = 0;
  let totalLogCount = 0;
  const dailySummaries = Array.from(buckets, ([date, bucket]) => {
    totalFocusScoreSum += bucket.focus_score_sum;
    totalLogCount += bucket.log_count;
    return {
      date,
      session_count: bucket.session_count,
      total_study_seconds: bucket.total_study_seconds,
      avg_focus_score: weightedAverage(bucket.focus_score_sum, bucket.log_count),
    };
  });

  return {
    period: { start_date: toDateKey(start), end_date: toDateKey(end) },
    daily_summaries: dailySummaries,
    avg_focus_score: weightedAverage(totalFocusScoreSum, totalLogCount),
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
      },
    });

    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('리포트에 대한 권한이 없습니다.', 403));
    if (session.status !== 'COMPLETED' || !session.ended_at || !session.report) {
      return next(createError('리포트가 아직 생성되지 않았습니다.', 404));
    }

    const timeline = await getSessionTimeline(session_id);

    return res.status(200).json({
      success: true,
      data: {
        report_id: session.report.id,
        session_id: session.id,
        summary_json: session.report.summary_json,
        timeline,
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
