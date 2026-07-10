// src/controllers/rankingsController.js
// v_rankings View 기반 집계 — ranking_participation=false 사용자 제외
const prisma = require('../models/prismaClient');

/** GET /api/rankings */
const getRankings = async (req, res, next) => {
  try {
    const { scope = 'global', period = 'weekly', metric = 'focus_score' } = req.query;

    // TODO: Phase 3에서 v_rankings Materialized View 쿼리로 교체
    // 현재는 concentration_logs + user_privacy_settings에서 직접 집계 (목업 로직)
    const since = new Date();
    since.setDate(since.getDate() - (period === 'daily' ? 1 : 7));

    const logs = await prisma.concentration_logs.groupBy({
      by: ['session_id'],
      where: {
        logged_at: { gte: since },
        sessions: {
          users: {
            user_privacy_settings: { ranking_participation: true },
          },
        },
      },
      _avg: { focus_score: true },
      _count: { id: true },
    });

    const rankings = logs
      .sort((a, b) => (b._avg.focus_score ?? 0) - (a._avg.focus_score ?? 0))
      .slice(0, 50)
      .map((item, idx) => ({
        rank: idx + 1,
        session_id: item.session_id,
        avg_focus_score: item._avg.focus_score,
        log_count: item._count.id,
      }));

    return res.status(200).json({ success: true, data: { rankings, scope, period, metric }, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getRankings };
