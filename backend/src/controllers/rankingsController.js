// v_rankings View 기반 집계 — ranking_participation=false 사용자는 View에서 제외
const { Prisma } = require('@prisma/client');
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

const toDateKey = (date) => date.toISOString().slice(0, 10);

const getPeriodStart = (period) => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'weekly') start.setUTCDate(start.getUTCDate() - 6);
  return toDateKey(start);
};

const getScopeUserIds = async (scope, groupId, viewerId) => {
  if (scope === 'global') return null;

  if (scope === 'friends') {
    const connections = await prisma.user_connections.findMany({
      where: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] },
      select: { user_a_id: true, user_b_id: true },
    });
    return [
      viewerId,
      ...connections.map((connection) =>
        connection.user_a_id === viewerId ? connection.user_b_id : connection.user_a_id,
      ),
    ];
  }

  const group = await prisma.groups.findFirst({
    where: { id: groupId, status: 'ACTIVE', deleted_at: null },
    select: { id: true },
  });
  if (!group) throw createError('그룹을 찾을 수 없습니다.', 404);

  const viewerMembership = await prisma.group_members.findUnique({
    where: { group_id_user_id: { group_id: groupId, user_id: viewerId } },
    select: { status: true },
  });
  if (viewerMembership?.status !== 'ACTIVE') {
    throw createError('해당 그룹의 구성원이 아닙니다.', 403);
  }

  const members = await prisma.group_members.findMany({
    where: { group_id: groupId, status: 'ACTIVE' },
    select: { user_id: true },
  });
  return members.map((member) => member.user_id);
};

/** GET /api/rankings */
const getRankings = async (req, res, next) => {
  try {
    const viewerId = req.user.sub;
    const { scope, period, metric, group_id: groupId } = req.query;
    const scopeUserIds = await getScopeUserIds(scope, groupId, viewerId);
    const periodStart = getPeriodStart(period);
    const scopeFilter = scopeUserIds
      ? Prisma.sql`AND user_id IN (${Prisma.join(scopeUserIds)})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw(
      Prisma.sql`
        SELECT
          user_id,
          nickname,
          profile_image_url,
          CASE
            WHEN SUM(focus_log_count) > 0
            THEN ROUND(SUM(focus_score_sum) / SUM(focus_log_count), 2)::DOUBLE PRECISION
            ELSE NULL
          END AS avg_focus_score,
          SUM(total_study_seconds)::INT AS total_study_seconds,
          SUM(session_count)::INT AS session_count
        FROM v_rankings
        WHERE activity_date >= CAST(${periodStart} AS DATE)
        ${scopeFilter}
        GROUP BY user_id, nickname, profile_image_url
      `,
    );

    const rankedRows = rows
      .map((row) => ({
        user_id: row.user_id,
        nickname: row.nickname,
        profile_image_url: row.profile_image_url,
        value:
          metric === 'focus_score'
            ? row.avg_focus_score === null
              ? null
              : Number(row.avg_focus_score)
            : Number(row.total_study_seconds),
        session_count: Number(row.session_count),
      }))
      .filter((row) => row.value !== null)
      .sort((left, right) => right.value - left.value || left.user_id.localeCompare(right.user_id))
      .map((row, index) => ({ rank: index + 1, ...row }));

    const myRanking = rankedRows.find((row) => row.user_id === viewerId);

    return res.status(200).json({
      success: true,
      data: {
        scope,
        period,
        metric,
        rankings: rankedRows.slice(0, 50),
        my_rank: myRanking ? { rank: myRanking.rank, value: myRanking.value } : null,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getRankings };
