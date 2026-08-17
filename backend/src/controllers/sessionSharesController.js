// ERD 원칙: session_shares.user_id 컬럼 없음 — 소유자는 session_id → sessions.user_id로 판단
// 공감 수 등 파생 값은 v_session_share_reaction_counts View에서 산출
const { Prisma } = require('@prisma/client');
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

const SCOPE_RANK = { PRIVATE: 0, FRIENDS: 1, GROUP: 2, PUBLIC: 3 };

const getViewerContext = async (viewerId) => {
  const [connections, memberships] = await Promise.all([
    prisma.user_connections.findMany({
      where: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] },
      select: { user_a_id: true, user_b_id: true },
    }),
    prisma.group_members.findMany({
      where: { user_id: viewerId, status: 'ACTIVE' },
      select: { group_id: true },
    }),
  ]);

  const friendIds = new Set(
    connections.map((connection) =>
      connection.user_a_id === viewerId ? connection.user_b_id : connection.user_a_id,
    ),
  );
  const groupIds = memberships.map((membership) => membership.group_id);
  const commonGroupMembers = groupIds.length
    ? await prisma.group_members.findMany({
        where: { group_id: { in: groupIds }, status: 'ACTIVE' },
        select: { user_id: true },
      })
    : [];

  return {
    friendIds,
    groupIds: new Set(groupIds),
    commonGroupUserIds: new Set(commonGroupMembers.map((membership) => membership.user_id)),
  };
};

const isWithinOwnerPrivacy = (shareScope, privacy) =>
  Boolean(privacy) && SCOPE_RANK[shareScope] <= SCOPE_RANK[privacy.default_session_scope];

const canAccessShare = (share, viewerId, context) => {
  const ownerId = share.session.user_id;
  if (ownerId === viewerId) return true;
  if (share.share_scope === 'PUBLIC') return true;
  if (share.share_scope === 'FRIENDS') return context.friendIds.has(ownerId);
  if (share.share_scope === 'GROUP') return Boolean(share.group_id) && context.groupIds.has(share.group_id);
  return false;
};

const canViewField = (visibility, ownerId, viewerId, context) => {
  if (ownerId === viewerId || visibility === 'PUBLIC') return true;
  if (visibility === 'FRIENDS') return context.friendIds.has(ownerId);
  if (visibility === 'GROUP') return context.commonGroupUserIds.has(ownerId);
  return false;
};

const findAccessibleShare = async (shareId, viewerId) => {
  const share = await prisma.session_shares.findFirst({
    where: { id: shareId, status: 'ACTIVE', deleted_at: null },
    include: {
      session: {
        select: {
          user_id: true,
          user: { select: { user_privacy_settings: true } },
        },
      },
    },
  });
  if (!share) throw createError('공유 게시물을 찾을 수 없습니다.', 404);

  const context = await getViewerContext(viewerId);
  const privacy = share.session.user.user_privacy_settings;
  if (!isWithinOwnerPrivacy(share.share_scope, privacy) || !canAccessShare(share, viewerId, context)) {
    throw createError('해당 공유 게시물에 접근할 수 없습니다.', 403);
  }

  return share;
};

/** POST /api/session-shares */
const createShare = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { session_id, share_scope, group_id, share_message } = req.body;

    const session = await prisma.sessions.findUnique({
      where: { id: session_id },
      select: { id: true, user_id: true, status: true },
    });
    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('해당 세션에 대한 권한이 없습니다.', 403));
    if (session.status !== 'COMPLETED') return next(createError('진행 중인 세션은 공유할 수 없습니다.', 409));

    const privacy = await prisma.user_privacy_settings.findUnique({ where: { user_id: userId } });
    if (!privacy) return next(createError('프라이버시 설정을 찾을 수 없습니다.', 500));
    if (!isWithinOwnerPrivacy(share_scope, privacy)) {
      return next(
        createError('프라이버시 설정(default_session_scope)보다 넓은 범위로 공유할 수 없습니다.', 403),
      );
    }

    const normalizedGroupId = share_scope === 'GROUP' ? group_id : null;
    if (share_scope === 'GROUP') {
      const group = await prisma.groups.findFirst({
        where: { id: group_id, status: 'ACTIVE', deleted_at: null },
        select: { id: true },
      });
      if (!group) return next(createError('그룹을 찾을 수 없습니다.', 404));

      const membership = await prisma.group_members.findUnique({
        where: { group_id_user_id: { group_id, user_id: userId } },
        select: { status: true },
      });
      if (membership?.status !== 'ACTIVE') {
        return next(createError('해당 그룹의 구성원이 아닙니다.', 403));
      }
    }

    const existingShare = await prisma.session_shares.findFirst({
      where: { session_id, share_scope, group_id: normalizedGroupId },
      select: { id: true },
    });
    if (existingShare) return next(createError('동일 범위로 이미 공유된 세션입니다.', 409));

    const share = await prisma.session_shares.create({
      data: {
        session_id,
        group_id: normalizedGroupId,
        share_scope,
        share_message,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        session_id: true,
        share_scope: true,
        group_id: true,
        share_message: true,
        status: true,
        created_at: true,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        share_id: share.id,
        session_id: share.session_id,
        share_scope: share.share_scope,
        group_id: share.group_id,
        share_message: share.share_message,
        status: share.status,
        created_at: share.created_at,
      },
      error: '',
    });
  } catch (err) {
    if (err.code === 'P2002') return next(createError('동일 범위로 이미 공유된 세션입니다.', 409));
    next(err);
  }
};

/** GET /api/session-shares/feed */
const getFeed = async (req, res, next) => {
  try {
    const viewerId = req.user.sub;
    const page = Number.parseInt(req.query.page || '1', 10);
    const limit = Number.parseInt(req.query.limit || '20', 10);
    const scope = req.query.scope || 'all';
    const context = await getViewerContext(viewerId);

    let scopeFilter;
    if (scope === 'public') {
      scopeFilter = { share_scope: 'PUBLIC' };
    } else if (scope === 'friends') {
      scopeFilter = {
        share_scope: 'FRIENDS',
        session: { user_id: { in: Array.from(context.friendIds) } },
      };
    } else {
      scopeFilter = {
        OR: [
          { share_scope: 'PUBLIC' },
          {
            share_scope: 'FRIENDS',
            session: { user_id: { in: Array.from(context.friendIds) } },
          },
          { share_scope: 'GROUP', group_id: { in: Array.from(context.groupIds) } },
          { session: { user_id: viewerId } },
        ],
      };
    }

    const candidates = await prisma.session_shares.findMany({
      where: { status: 'ACTIVE', deleted_at: null, ...scopeFilter },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        session_id: true,
        group_id: true,
        share_scope: true,
        share_message: true,
        created_at: true,
        reactions: {
          where: { user_id: viewerId },
          select: { reaction_type: true },
        },
        session: {
          select: {
            user_id: true,
            started_at: true,
            ended_at: true,
            concentration_logs: { select: { focus_score: true } },
            user: {
              select: {
                user_profile: { select: { nickname: true, profile_image_url: true } },
                user_privacy_settings: true,
              },
            },
          },
        },
      },
    });

    const accessibleShares = candidates.filter((share) => {
      const privacy = share.session.user.user_privacy_settings;
      return isWithinOwnerPrivacy(share.share_scope, privacy) && canAccessShare(share, viewerId, context);
    });
    const total = accessibleShares.length;
    const pagedShares = accessibleShares.slice((page - 1) * limit, page * limit);
    const shareIds = pagedShares.map((share) => share.id);

    const reactionRows = shareIds.length
      ? await prisma.$queryRaw(
          Prisma.sql`
            SELECT session_share_id, reaction_type, reaction_count
            FROM v_session_share_reaction_counts
            WHERE session_share_id IN (${Prisma.join(shareIds)})
          `,
        )
      : [];
    const reactionCounts = new Map();
    for (const row of reactionRows) {
      if (!reactionCounts.has(row.session_share_id)) {
        reactionCounts.set(row.session_share_id, { LIKE: 0, CHEER: 0, EMPATHY: 0 });
      }
      reactionCounts.get(row.session_share_id)[row.reaction_type] = Number(row.reaction_count);
    }

    const feed = pagedShares.map((share) => {
      const ownerId = share.session.user_id;
      const privacy = share.session.user.user_privacy_settings;
      const scores = share.session.concentration_logs.map((log) => log.focus_score);
      const average = scores.length
        ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
        : null;
      const duration = share.session.ended_at
        ? Math.max(0, Math.floor((share.session.ended_at - share.session.started_at) / 1000))
        : null;

      return {
        share_id: share.id,
        session_id: share.session_id,
        share_scope: share.share_scope,
        group_id: share.group_id,
        share_message: share.share_message,
        owner: {
          user_id: ownerId,
          nickname: share.session.user.user_profile?.nickname ?? null,
          profile_image_url: share.session.user.user_profile?.profile_image_url ?? null,
        },
        session_summary: {
          started_at: share.session.started_at,
          duration_seconds: canViewField(
            privacy.study_time_visibility,
            ownerId,
            viewerId,
            context,
          )
            ? duration
            : null,
          avg_focus_score: canViewField(privacy.score_visibility, ownerId, viewerId, context)
            ? average
            : null,
        },
        reaction_counts: reactionCounts.get(share.id) ?? { LIKE: 0, CHEER: 0, EMPATHY: 0 },
        my_reactions: share.reactions.map((reaction) => reaction.reaction_type),
        created_at: share.created_at,
      };
    });

    return res.status(200).json({
      success: true,
      data: { feed, pagination: { page, limit, total } },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/session-shares/:id/reactions */
const addReaction = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionShareId } = req.params;
    const { reaction_type } = req.body;

    await findAccessibleShare(sessionShareId, userId);
    const reaction = await prisma.session_reactions.create({
      data: { session_share_id: sessionShareId, user_id: userId, reaction_type },
      select: { id: true, session_share_id: true, reaction_type: true, created_at: true },
    });

    return res.status(201).json({
      success: true,
      data: {
        reaction_id: reaction.id,
        session_share_id: reaction.session_share_id,
        reaction_type: reaction.reaction_type,
        created_at: reaction.created_at,
      },
      error: '',
    });
  } catch (err) {
    if (err.code === 'P2002') return next(createError('이미 동일 유형의 반응을 남겼습니다.', 409));
    next(err);
  }
};

/** DELETE /api/session-shares/:id/reactions/:reactionType */
const removeReaction = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionShareId, reactionType } = req.params;

    await findAccessibleShare(sessionShareId, userId);
    await prisma.session_reactions.deleteMany({
      where: { session_share_id: sessionShareId, user_id: userId, reaction_type: reactionType },
    });

    return res.status(200).json({
      success: true,
      data: { message: '공감 반응이 취소되었습니다.' },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { createShare, getFeed, addReaction, removeReaction };
