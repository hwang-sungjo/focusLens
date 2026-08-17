// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../models/prismaClient');
const { blacklistToken } = require('../services/redis');

const SALT_ROUNDS = 12;

const issueAccessToken = (user) => {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
  );
  const decoded = jwt.decode(accessToken);

  return {
    accessToken,
    expiresIn: decoded.exp - decoded.iat,
  };
};

/** POST /api/auth/register */
const register = async (req, res, next) => {
  try {
    const { email, password, name, nickname } = req.body;

    const [existingUser, existingProfile] = await Promise.all([
      prisma.users.findUnique({ where: { email } }),
      prisma.user_profiles.findUnique({ where: { nickname } }),
    ]);

    if (existingUser) {
      return res.status(409).json({ success: false, data: {}, error: '이미 사용 중인 이메일입니다.' });
    }
    if (existingProfile) {
      return res.status(409).json({ success: false, data: {}, error: '이미 사용 중인 닉네임입니다.' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.users.create({
      data: {
        email,
        password_hash,
        name,
        // 가입 시 user_profiles, user_privacy_settings 기본값 자동 생성
        user_profile: { create: { nickname } },
        user_privacy_settings: {
          create: {
            default_session_scope: 'PRIVATE',
            ranking_participation: false,
          },
        },
      },
      select: { id: true, email: true, name: true, role: true, created_at: true },
    });

    const { accessToken, expiresIn } = issueAccessToken(user);

    return res.status(201).json({
      success: true,
      data: {
        user_id: user.id,
        email: user.email,
        name: user.name,
        access_token: accessToken,
        expires_in: expiresIn,
      },
      error: '',
    });
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

    if (user.status !== 'ACTIVE' || user.deleted_at) {
      return res.status(403).json({ success: false, data: {}, error: '비활성화된 계정입니다.' });
    }

    const { accessToken, expiresIn } = issueAccessToken(user);

    return res.status(200).json({
      success: true,
      data: {
        user_id: user.id,
        email: user.email,
        name: user.name,
        access_token: accessToken,
        expires_in: expiresIn,
      },
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
      await blacklistToken(token, remaining);
    }
    return res.status(200).json({
      success: true,
      data: { message: '로그아웃되었습니다.' },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, logout };
