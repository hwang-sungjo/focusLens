// src/middleware/errorHandler.js
// 전역 예외 처리 미들웨어 — 400/401/403/404/500 응답 표준화
// 반드시 app.js에서 모든 라우터 등록 후 마지막에 등록해야 함

/**
 * 404 Not Found 핸들러
 * 등록된 라우트가 없을 때 호출
 */
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    data: {},
    error: `요청한 경로를 찾을 수 없습니다: ${req.method} ${req.originalUrl}`,
  });
};

/**
 * 전역 에러 핸들러 (4-argument Express 에러 핸들러)
 * next(err) 또는 throw된 에러를 처리
 */
const { logEvent, recordMetric } = require('../services/observability');

const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const isDatabaseUnavailable = (err) => {
  if (DATABASE_UNAVAILABLE_CODES.has(err.code || err.errorCode)) return true;
  // Prisma raw queries preserve the PostgreSQL SQLSTATE in meta.code.
  const sqlState = err.meta?.code;
  return err.code === 'P2010' && typeof sqlState === 'string'
    && (/^08/.test(sqlState) || ['57P01', '57P02', '57P03'].includes(sqlState));
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const databaseCode = err.code || err.errorCode;
  const isDatabaseError = typeof databaseCode === 'string' && /^P\d{4}$/.test(databaseCode);
  if (isDatabaseError) recordMetric('database_errors_total', { code: databaseCode });
  logEvent('application_error', {
    request_id: req.requestId ?? null,
    user_id: req.user?.sub ?? null,
    method: req.method,
    path: (req.originalUrl || req.path || '').split('?')[0],
    error_name: err.name,
    error_code: err.code ?? null,
    message: (err.statusCode || err.status) < 500 || process.env.NODE_ENV !== 'production'
      ? err.message
      : 'internal_error',
  }, 'error');

  if (isDatabaseUnavailable(err)) {
    return res.status(503).json({
      success: false,
      data: {},
      error: '데이터베이스에 일시적으로 연결할 수 없습니다.',
    });
  }

  // Prisma 에러 처리
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      data: {},
      error: '이미 존재하는 데이터입니다.',
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      data: {},
      error: '요청한 리소스를 찾을 수 없습니다.',
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode >= 500
    ? '서버 내부 오류가 발생했습니다.'
    : err.message || '요청 처리 중 오류가 발생했습니다.';

  res.status(statusCode).json({
    success: false,
    data: {},
    error: message,
  });
};

/**
 * 커스텀 HTTP 에러 생성 헬퍼
 * @param {string} message
 * @param {number} statusCode
 */
const createError = (message, statusCode = 500) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

module.exports = { notFound, errorHandler, createError };
