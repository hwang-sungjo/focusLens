// src/services/redis.js
// Redis 클라이언트 싱글턴 — JWT 블랙리스트, 중복 전송 차단용 캐시
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 3) {
      console.error('[Redis] 재연결 실패 — Redis 없이 서버 계속 실행');
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on('connect', () => console.log('[Redis] 연결 성공'));
redis.on('error', (err) => console.error('[Redis] 연결 오류:', err.message));

/**
 * JWT 블랙리스트에 토큰 추가
 * @param {string} token - 무효화할 JWT
 * @param {number} ttlSeconds - 만료 시간(초), JWT 남은 유효기간과 일치시킴
 */
const blacklistToken = async (token, ttlSeconds) => {
  await redis.set(`bl:${token}`, '1', 'EX', ttlSeconds);
};

/**
 * 토큰이 블랙리스트에 있는지 확인
 * @param {string} token
 * @returns {Promise<boolean>}
 */
const isTokenBlacklisted = async (token) => {
  const result = await redis.get(`bl:${token}`);
  return result !== null;
};

/**
 * 세션 로그 마지막 전송 시각 저장 (1분 중복 방지)
 * @param {string} sessionId
 * @param {number} ttlSeconds
 */
const setLastLogTime = async (sessionId, ttlSeconds = 60) => {
  await redis.set(`log:${sessionId}`, Date.now().toString(), 'EX', ttlSeconds);
};

/**
 * 세션 로그 마지막 전송 시각 조회
 * @param {string} sessionId
 * @returns {Promise<number|null>}
 */
const getLastLogTime = async (sessionId) => {
  const val = await redis.get(`log:${sessionId}`);
  return val ? parseInt(val, 10) : null;
};

module.exports = {
  redis,
  blacklistToken,
  isTokenBlacklisted,
  setLastLogTime,
  getLastLogTime,
};
