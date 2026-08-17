// src/routes/sessions.js
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const sessionsController = require('../controllers/sessionsController');

const router = Router();

const scoreBody = (field) =>
  body(field).custom((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${field}는 0~100 범위의 숫자여야 합니다.`);
    }
    return true;
  });

// 모든 세션 라우트는 JWT 인증 필요
router.use(authenticate);

// POST /api/sessions/start
router.post('/start', sessionsController.startSession);

// POST /api/sessions/:id/log — 집중도 로그 저장 (보안 검증 4조건 컨트롤러에서 처리)
router.post(
  '/:id/log',
  [
    param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.'),
    scoreBody('gaze'),
    scoreBody('blink'),
    scoreBody('head'),
    scoreBody('total'),
    body('face_detected')
      .optional()
      .custom((value) => typeof value === 'boolean')
      .withMessage('face_detected는 boolean이어야 합니다.'),
  ],
  validate,
  sessionsController.logConcentration,
);

// POST /api/sessions/:id/end
router.post(
  '/:id/end',
  [param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.')],
  validate,
  sessionsController.endSession,
);

// GET /api/sessions  — 내 세션 목록
router.get(
  '/',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  ],
  validate,
  sessionsController.getSessions,
);

// GET /api/sessions/:id  — 세션 상세 (분 단위 타임라인 포함)
router.get(
  '/:id',
  [param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.')],
  validate,
  sessionsController.getSession,
);

module.exports = router;
