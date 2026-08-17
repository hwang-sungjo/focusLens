// src/routes/connections.js
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const connectionsController = require('../controllers/connectionsController');

const router = Router();

router.use(authenticate);

// POST /api/connections/request  — 친구 요청
router.post(
  '/request',
  [body('receiver_user_id').isUUID().withMessage('유효한 사용자 ID가 아닙니다.')],
  validate,
  connectionsController.sendRequest,
);

// PATCH /api/connections/:id  — 친구 요청 수락/거절
router.patch(
  '/:id',
  [
    param('id').isUUID().withMessage('유효한 요청 ID가 아닙니다.'),
    body('status')
      .isIn(['ACCEPTED', 'REJECTED', 'CANCELLED'])
      .withMessage('status는 ACCEPTED, REJECTED, CANCELLED 중 하나여야 합니다.'),
  ],
  validate,
  connectionsController.respondRequest,
);

// GET /api/connections  — 친구 목록 및 대기 요청 조회
router.get(
  '/',
  [
    query('include_pending')
      .optional()
      .isIn(['true', 'false'])
      .withMessage('include_pending은 true 또는 false여야 합니다.'),
  ],
  validate,
  connectionsController.getConnections,
);

module.exports = router;
