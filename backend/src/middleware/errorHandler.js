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
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  console.error(`[Error] ${err.stack || err.message}`);

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
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? '서버 내부 오류가 발생했습니다.'
      : err.message || '서버 내부 오류가 발생했습니다.';

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
