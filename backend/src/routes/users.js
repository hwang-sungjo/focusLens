// src/routes/users.js
const { Router } = require('express');
const { param, body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const usersController = require('../controllers/usersController');

const router = Router();
const visibilityLevels = ['PUBLIC', 'FRIENDS', 'GROUP', 'PRIVATE'];

router.use(authenticate);

// GET /api/users/:id/profile  — 공개 프로필 조회
router.get(
  '/:id/profile',
  [param('id').isUUID().withMessage('유효한 사용자 ID가 아닙니다.')],
  validate,
  usersController.getPublicProfile,
);

// PATCH /api/users/me/profile  — 내 프로필 수정
router.patch(
  '/me/profile',
  [
    body('nickname').optional().isString().isLength({ min: 2, max: 30 }),
    body('bio').optional({ values: 'null' }).isString().isLength({ max: 200 }),
    body('profile_image_url').optional({ values: 'null' }).isURL(),
  ],
  validate,
  usersController.updateMyProfile,
);

// GET /api/users/me/privacy  — 프라이버시 설정 조회
router.get('/me/privacy', usersController.getPrivacySettings);

// PATCH /api/users/me/privacy  — 프라이버시 설정 수정
router.patch(
  '/me/privacy',
  [
    body('default_session_scope')
      .optional()
      .isIn(visibilityLevels)
      .withMessage('유효한 공개 범위가 아닙니다.'),
    body('score_visibility')
      .optional()
      .isIn(visibilityLevels)
      .withMessage('유효한 점수 공개 범위가 아닙니다.'),
    body('study_time_visibility')
      .optional()
      .isIn(visibilityLevels)
      .withMessage('유효한 학습 시간 공개 범위가 아닙니다.'),
    body('group_data_sharing').optional().isBoolean({ strict: true }),
    body('ranking_participation').optional().isBoolean({ strict: true }),
  ],
  validate,
  usersController.updatePrivacySettings,
);

module.exports = router;
