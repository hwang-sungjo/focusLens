// src/middleware/validate.js
// express-validator 결과를 검사하는 미들웨어
// 라우터에서 validationResult를 매번 작성하는 중복을 제거
const { validationResult } = require('express-validator');

/**
 * express-validator의 validation 결과를 검사
 * 오류가 있으면 400 응답 반환, 없으면 next()
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: {},
      error: errors
        .array()
        .map((e) => `${e.path}: ${e.msg}`)
        .join(', '),
    });
  }
  next();
};

module.exports = { validate };
