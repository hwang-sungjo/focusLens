// src/services/redis.js
// Redis 클라이언트 싱글턴 — JWT 블랙리스트용 캐시
const Redis = require('ioredis');
const { createHash } = require('crypto');
const { logEvent, recordMetric } = require('./observability');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Keep reconnecting after an outage, but never queue authentication requests.
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
  commandTimeout: 1500,
  retryStrategy: (times) => {
    recordMetric('redis_connection_errors_total', { phase: 'retry' });
    return Math.min(times * 200, 2000);
  },
});

redis.on('connect', () => logEvent('redis_connected'));
redis.on('error', (err) => {
  recordMetric('redis_connection_errors_total', { phase: 'runtime' });
  logEvent('redis_connection_error', {
    error_code: err.code ?? null,
    message: 'redis_connection_failed',
  }, 'error');
});

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

module.exports = {
  redis,
  blacklistToken,
  isTokenBlacklisted,
};
