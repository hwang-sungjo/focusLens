// src/routes/connections.js
const { Router } = require('express');
const { body, param } = require('express-validator');
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
      .isIn(['ACCEPTED', 'REJECTED'])
      .withMessage('status는 ACCEPTED 또는 REJECTED이어야 합니다.'),
  ],
  validate,
  connectionsController.respondRequest,
);

// GET /api/connections  — 친구 목록 조회
router.get('/', connectionsController.getConnections);

module.exports = router;
