// src/controllers/sessionSharesController.js
// ERD 원칙: session_shares.user_id 컬럼 없음 — 소유자는 session_id → sessions.user_id로 판단
// 공감 수 등 파생 값은 v_session_share_reaction_counts View에서 산출
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

/** POST /api/session-shares */
const createShare = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { session_id, share_scope, group_id, share_message } = req.body;

    // 세션 소유자 검증 — session_id → sessions.user_id로 확인
    const session = await prisma.sessions.findUnique({ where: { id: session_id } });
    if (!session) return next(createError('세션을 찾을 수 없습니다.', 404));
    if (session.user_id !== userId) return next(createError('세션에 대한 권한이 없습니다.', 403));

    // user_privacy_settings.default_session_scope 초과 공개 차단
    const privacy = await prisma.user_privacy_settings.findUnique({ where: { user_id: userId } });
    const scopeRank = { PRIVATE: 0, GROUP: 1, FRIENDS: 2, PUBLIC: 3 };
    if (scopeRank[share_scope] > scopeRank[privacy?.default_session_scope ?? 'PRIVATE']) {
      return res.status(403).json({ success: false, data: {}, error: '프라이버시 설정을 초과하는 공개 범위입니다.' });
    }

    const share = await prisma.session_shares.create({
      data: {
        session_id,
        group_id: share_scope === 'GROUP' ? group_id : null,
        share_scope,
        share_message,
        status: 'ACTIVE',
      },
      select: { id: true, share_scope: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { share }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/session-shares/feed — v_session_share_reaction_counts View 활용 */
const getFeed = async (req, res, next) => {
  try {
    // TODO: Phase 3에서 v_session_share_reaction_counts View 쿼리로 교체
    // 현재는 기본 피드 조회 (PUBLIC 세션 + FRIENDS 공유)
    const userId = req.user.sub;

    const shares = await prisma.session_shares.findMany({
      where: {
        status: 'ACTIVE',
        share_scope: 'PUBLIC',
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        share_scope: true,
        share_message: true,
        created_at: true,
        sessions: { select: { started_at: true, ended_at: true } },
      },
    });

    return res.status(200).json({ success: true, data: { feed: shares }, error: '' });
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

    const share = await prisma.session_shares.findUnique({ where: { id: sessionShareId } });
    if (!share || share.status !== 'ACTIVE') return next(createError('공유 세션을 찾을 수 없습니다.', 404));

    // UNIQUE(session_share_id, user_id, reaction_type) 중복 방지
    const reaction = await prisma.session_reactions.create({
      data: { session_share_id: sessionShareId, user_id: userId, reaction_type },
      select: { id: true, reaction_type: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { reaction }, error: '' });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, data: {}, error: '이미 동일한 반응을 등록했습니다.' });
    }
    next(err);
  }
};

/** DELETE /api/session-shares/:id/reactions/:reactionType */
const removeReaction = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: sessionShareId, reactionType } = req.params;

    await prisma.session_reactions.deleteMany({
      where: { session_share_id: sessionShareId, user_id: userId, reaction_type: reactionType },
    });

    return res.status(200).json({ success: true, data: {}, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { createShare, getFeed, addReaction, removeReaction };
