// src/routes/reports.js
const { Router } = require('express');
const { param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const reportsController = require('../controllers/reportsController');

const router = Router();

router.use(authenticate);

// GET /api/reports/weekly  — 주간 집중도 요약 (/:session_id보다 먼저 등록)
const periodValidators = [
  query('end_date')
    .optional()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('end_date는 YYYY-MM-DD 형식이어야 합니다.'),
];

router.get('/weekly', periodValidators, validate, reportsController.getWeeklyReport);

// GET /api/reports/monthly (선택)
router.get('/monthly', periodValidators, validate, reportsController.getMonthlyReport);

// GET /api/reports/:session_id  — 세션별 리포트
router.get(
  '/:session_id',
  [param('session_id').isUUID().withMessage('유효한 세션 ID가 아닙니다.')],
  validate,
  reportsController.getReport,
);

module.exports = router;
