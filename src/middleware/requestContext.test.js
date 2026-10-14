const { EventEmitter } = require('events');
const { requestContext } = require('../../backend/src/middleware/requestContext');
const { getMetricsSnapshot } = require('../../backend/src/services/observability');

const createResponse = () => {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = jest.fn();
  return res;
};

describe('structured request logging', () => {
  let consoleLog;

  beforeEach(() => {
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => consoleLog.mockRestore());

  it('preserves a safe request id and logs identity, status, path, and duration', () => {
    const req = {
      method: 'GET',
      path: '/api/sessions/2f90c7ad-d6e5-4b20-a241-3ca7b19d8d69',
      originalUrl: '/api/sessions/2f90c7ad-d6e5-4b20-a241-3ca7b19d8d69?include=timeline',
      get: jest.fn().mockReturnValue('client-request-123'),
    };
    const res = createResponse();
    const next = jest.fn();

    requestContext(req, res, next);
    req.user = { sub: 'user-id' };
    res.statusCode = 403;
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.requestId).toBe('client-request-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'client-request-123');
    const logged = JSON.parse(consoleLog.mock.calls.at(-1)[0]);
    expect(logged).toEqual(expect.objectContaining({
      event: 'http_request',
      request_id: 'client-request-123',
      user_id: 'user-id',
      path: '/api/sessions/2f90c7ad-d6e5-4b20-a241-3ca7b19d8d69',
      status_code: 403,
      duration_ms: expect.any(Number),
    }));
    expect(getMetricsSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'permission_denials_total',
        labels: { route: '/api/sessions/:id' },
      }),
    ]));
  });

  it('replaces an unsafe request id', () => {
    const req = {
      method: 'GET',
      path: '/health',
      originalUrl: '/health',
      get: jest.fn().mockReturnValue('bad id\nvalue'),
    };
    const res = createResponse();

    requestContext(req, res, jest.fn());
    res.emit('finish');

    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.requestId).not.toContain('bad id');
  });
});
