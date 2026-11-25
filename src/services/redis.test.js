jest.mock('ioredis', () => jest.fn(() => ({
  on: jest.fn(), set: jest.fn(), get: jest.fn(),
})), { virtual: true });
jest.mock('../../backend/src/services/observability', () => ({
  logEvent: jest.fn(), recordMetric: jest.fn(),
}));

const Redis = require('ioredis');
const { redis, blacklistToken, isTokenBlacklisted } = require('../../backend/src/services/redis');
const { logEvent } = require('../../backend/src/services/observability');
const options = Redis.mock.calls[0][1];
const onConnectionError = redis.on.mock.calls.find(([event]) => event === 'error')[1];

describe('Redis authentication outage handling', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('keeps trying after a long outage and bounds retry delays', () => {
    for (const attempt of [1, 3, 4, 30, 100_000]) {
      const delay = options.retryStrategy(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it('rejects unavailable commands instead of replaying authentication writes after recovery', () => {
    expect(options).toMatchObject({
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 1000, commandTimeout: 1500,
    });
  });

  it('keeps private connection details out of runtime diagnostics', () => {
    onConnectionError(Object.assign(new Error('private connection password'), { code: 'ECONNREFUSED' }));
    expect(logEvent).toHaveBeenCalledWith('redis_connection_error', {
      error_code: 'ECONNREFUSED', message: 'redis_connection_failed',
    }, 'error');
  });

  it('propagates failed blacklist reads and writes', async () => {
    redis.get.mockRejectedValueOnce(new Error('unavailable'));
    redis.set.mockRejectedValueOnce(new Error('unavailable'));
    await expect(isTokenBlacklisted('private-token')).rejects.toThrow('unavailable');
    await expect(blacklistToken('private-token', 60)).rejects.toThrow('unavailable');
  });

  it('hashes token keys and retains the remaining token lifetime', async () => {
    redis.set.mockResolvedValueOnce('OK');
    redis.get.mockResolvedValueOnce('1');
    await blacklistToken('private-token', 60);
    const key = redis.set.mock.calls[0][0];
    expect(key).toMatch(/^blacklist:[a-f0-9]{64}$/);
    expect(key).not.toContain('private-token');
    expect(redis.set).toHaveBeenCalledWith(key, '1', 'EX', 60);
    await expect(isTokenBlacklisted('private-token')).resolves.toBe(true);
    expect(redis.get).toHaveBeenCalledWith(key);
  });
});
