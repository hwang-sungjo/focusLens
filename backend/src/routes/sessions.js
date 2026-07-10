// src/routes/sessions.js
const { Router } = require('express');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const sessionsController = require('../controllers/sessionsController');

const router = Router();

// 모든 세션 라우트는 JWT 인증 필요
router.use(authenticate);

// POST /api/sessions/start
router.post('/start', sessionsController.startSession);

// POST /api/sessions/:id/log — 집중도 로그 저장 (보안 검증 4조건 컨트롤러에서 처리)
router.post(
  '/:id/log',
  [
    param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.'),
    body('gaze_score').isFloat({ min: 0, max: 100 }).withMessage('gaze_score는 0~100 사이 숫자여야 합니다.'),
    body('blink_score').isFloat({ min: 0, max: 100 }).withMessage('blink_score는 0~100 사이 숫자여야 합니다.'),
    body('head_score').isFloat({ min: 0, max: 100 }).withMessage('head_score는 0~100 사이 숫자여야 합니다.'),
    body('face_detected').isBoolean().withMessage('face_detected는 boolean이어야 합니다.'),
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
router.get('/', sessionsController.getSessions);

// GET /api/sessions/:id  — 세션 상세 (분 단위 타임라인 포함)
router.get(
  '/:id',
  [param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.')],
  validate,
  sessionsController.getSession,
);

module.exports = router;
