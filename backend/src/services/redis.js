// src/services/redis.js
// Redis 클라이언트 싱글턴 — JWT 블랙리스트, 중복 전송 차단용 캐시
const Redis = require('ioredis');
const { createHash } = require('crypto');

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
const tokenBlacklistKey = (token) =>
  `blacklist:${createHash('sha256').update(token).digest('hex')}`;

const blacklistToken = async (token, ttlSeconds) => {
  await redis.set(tokenBlacklistKey(token), '1', 'EX', ttlSeconds);
};

/**
 * 토큰이 블랙리스트에 있는지 확인
 * @param {string} token
 * @returns {Promise<boolean>}
 */
const isTokenBlacklisted = async (token) => {
  const result = await redis.get(tokenBlacklistKey(token));
  return result !== null;
};

/**
 * 세션 로그 전송 잠금 획득 (1분 중복 방지)
 * @param {string} sessionId
 * @param {number} ttlSeconds
 */
const acquireLogRateLimit = async (sessionId, ttlSeconds = 60) => {
  const result = await redis.set(`session-log-rate:${sessionId}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
};

const releaseLogRateLimit = async (sessionId) => {
  await redis.del(`session-log-rate:${sessionId}`);
};

module.exports = {
  redis,
  blacklistToken,
  isTokenBlacklisted,
  acquireLogRateLimit,
  releaseLogRateLimit,
};
