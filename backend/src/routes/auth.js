// src/routes/auth.js
const { Router } = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const authController = require('../controllers/authController');

const router = Router();

// POST /api/auth/register
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('유효한 이메일을 입력해주세요.'),
    body('password').isLength({ min: 8 }).withMessage('비밀번호는 8자 이상이어야 합니다.'),
    body('name').notEmpty().withMessage('이름은 필수입니다.'),
    body('nickname')
      .isString()
      .trim()
      .isLength({ min: 2, max: 30 })
      .withMessage('닉네임은 2~30자여야 합니다.'),
  ],
  validate,
  authController.register,
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('유효한 이메일을 입력해주세요.'),
    body('password').notEmpty().withMessage('비밀번호를 입력해주세요.'),
  ],
  validate,
  authController.login,
);

// POST /api/auth/refresh — 회전형 Refresh Token 갱신
router.post(
  '/refresh',
  [
    body('refresh_token')
      .optional()
      .isString()
      .isLength({ min: 32, max: 512 })
      .withMessage('refresh_token 형식이 올바르지 않습니다.'),
  ],
  validate,
  authController.refresh,
);

// POST /api/auth/logout  (보호 라우트)
router.post(
  '/logout',
  authenticate,
  [
    body('refresh_token')
      .optional()
      .isString()
      .isLength({ min: 32, max: 512 })
      .withMessage('refresh_token 형식이 올바르지 않습니다.'),
  ],
  validate,
  authController.logout,
);

module.exports = router;
