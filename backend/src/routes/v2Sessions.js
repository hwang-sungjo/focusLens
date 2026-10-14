const { Router } = require('express');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const sessionsController = require('../controllers/sessionsController');

const router = Router();

const scoreBody = (field) => body(field).custom((value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field}는 0~100 범위의 숫자여야 합니다.`);
  }
  return true;
});

router.use(authenticate);

router.post(
  '/:id/log',
  [
    param('id').isUUID().withMessage('유효한 세션 ID가 아닙니다.'),
    body('client_log_id').isUUID('4').withMessage('client_log_id는 UUID v4여야 합니다.'),
    body('measured_at')
      .isString()
      .custom((value) => (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
        && Number.isFinite(Date.parse(value))
      ))
      .withMessage('measured_at은 UTC RFC 3339 형식이어야 합니다.'),
    scoreBody('gaze'),
    scoreBody('blink'),
    scoreBody('head'),
    scoreBody('total'),
    body('face_detected')
      .exists()
      .withMessage('face_detected는 필수입니다.')
      .bail()
      .custom((value) => typeof value === 'boolean')
      .withMessage('face_detected는 boolean이어야 합니다.'),
  ],
  validate,
  sessionsController.logConcentrationV2,
);

module.exports = router;
