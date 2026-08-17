// src/routes/sessionShares.js
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const sessionSharesController = require('../controllers/sessionSharesController');

const router = Router();

router.use(authenticate);

// POST /api/session-shares  — 세션 공유
router.post(
  '/',
  [
    body('session_id').isUUID().withMessage('유효한 세션 ID가 아닙니다.'),
    body('share_scope')
      .isIn(['PUBLIC', 'FRIENDS', 'GROUP'])
      .withMessage('share_scope는 PUBLIC / FRIENDS / GROUP 중 하나여야 합니다.'),
    body('group_id')
      .if(body('share_scope').equals('GROUP'))
      .isUUID()
      .withMessage('GROUP 공유 시 group_id는 필수입니다.'),
    body('share_message').optional({ values: 'null' }).isString().isLength({ max: 500 }),
  ],
  validate,
  sessionSharesController.createShare,
);

// GET /api/session-shares/feed  — 소셜 피드 조회 (v_session_share_reaction_counts 뷰 활용)
router.get(
  '/feed',
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page는 1 이상의 정수여야 합니다.'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit은 1~100 범위여야 합니다.'),
    query('scope')
      .optional()
      .isIn(['all', 'friends', 'public'])
      .withMessage('scope는 all, friends, public 중 하나여야 합니다.'),
  ],
  validate,
  sessionSharesController.getFeed,
);

// POST /api/session-shares/:id/reactions  — 공감 반응
router.post(
  '/:id/reactions',
  [
    param('id').isUUID().withMessage('유효한 공유 ID가 아닙니다.'),
    body('reaction_type')
      .isIn(['LIKE', 'CHEER', 'EMPATHY'])
      .withMessage('reaction_type은 LIKE / CHEER / EMPATHY 중 하나여야 합니다.'),
  ],
  validate,
  sessionSharesController.addReaction,
);

// DELETE /api/session-shares/:id/reactions/:reactionType  — 공감 반응 취소
router.delete(
  '/:id/reactions/:reactionType',
  [
    param('id').isUUID().withMessage('유효한 공유 ID가 아닙니다.'),
    param('reactionType').isIn(['LIKE', 'CHEER', 'EMPATHY']),
  ],
  validate,
  sessionSharesController.removeReaction,
);

module.exports = router;
