// src/middleware/auth.js
// JWT 인증 미들웨어 — 모든 보호 라우트에 적용
const jwt = require('jsonwebtoken');
const { isTokenBlacklisted } = require('../services/redis');

/**
 * Bearer 토큰을 검증하고 req.user에 페이로드를 주입
 * 실패 시 401 응답 반환
 */
const authenticate = async (req, res, next) => {
  let payload;
  let token;

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer\s+\S+$/.test(authHeader)) {
      return res.status(401).json({
        success: false,
        data: {},
        error: '인증 토큰이 필요합니다.',
      });
    }

    token = authHeader.slice('Bearer '.length).trim();
    payload = jwt.verify(token, process.env.JWT_SECRET);

    if (!payload.sub) {
      return res.status(401).json({ success: false, data: {}, error: '유효하지 않은 토큰입니다.' });
    }
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        data: {},
        error: '토큰이 만료되었습니다.',
      });
    }
    return res.status(401).json({
      success: false,
      data: {},
      error: '유효하지 않은 토큰입니다.',
    });
  }

  try {
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return res.status(401).json({
        success: false,
        data: {},
        error: '이미 로그아웃된 토큰입니다.',
      });
    }

    req.user = payload;
    req.token = token;
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { authenticate };
