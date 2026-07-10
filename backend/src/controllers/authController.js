// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../models/prismaClient');
const { blacklistToken } = require('../services/redis');
const { createError } = require('../middleware/errorHandler');

const SALT_ROUNDS = 12;

/** POST /api/auth/register */
const register = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, data: {}, error: '이미 사용 중인 이메일입니다.' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.users.create({
      data: {
        email,
        password_hash,
        name,
        // 가입 시 user_profiles, user_privacy_settings 기본값 자동 생성
        user_profiles: { create: { nickname: name } },
        user_privacy_settings: {
          create: {
            default_session_scope: 'PRIVATE',
            ranking_participation: false,
          },
        },
      },
      select: { id: true, email: true, name: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { user }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/auth/login */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.users.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ success: false, data: {}, error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, data: {}, error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
    );

    return res.status(200).json({
      success: true,
      data: { access_token: token, user: { id: user.id, email: user.email, name: user.name } },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/auth/logout */
const logout = async (req, res, next) => {
  try {
    const { token, user } = req;
    // JWT 남은 유효 기간만큼 Redis 블랙리스트에 등록
    const remaining = user.exp - Math.floor(Date.now() / 1000);
    if (remaining > 0) {
      await blacklistToken(token, remaining).catch(() => {});
    }
    return res.status(200).json({ success: true, data: {}, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, logout };
