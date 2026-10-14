jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}), { virtual: true });

jest.mock('../../backend/src/services/redis', () => ({
  isTokenBlacklisted: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const { isTokenBlacklisted } = require('../../backend/src/services/redis');
const { authenticate } = require('../../backend/src/middleware/auth');

const createResponse = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

const authenticateRequest = async (authorization) => {
  const req = { headers: { ...(authorization && { authorization }) } };
  const res = createResponse();
  const next = jest.fn();
  await authenticate(req, res, next);
  return { req, res, next };
};

describe('JWT authentication middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ sub: 'user-id', exp: 2_000_000_000 });
    isTokenBlacklisted.mockResolvedValue(false);
  });

  it('rejects a missing bearer token with 401', async () => {
    const { res, next } = await authenticateRequest();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: {},
      error: '인증 토큰이 필요합니다.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid non-blacklisted token', async () => {
    const { req, res, next } = await authenticateRequest('Bearer valid-token');

    expect(jwt.verify).toHaveBeenCalledWith('valid-token', process.env.JWT_SECRET);
    expect(isTokenBlacklisted).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual({ sub: 'user-id', exp: 2_000_000_000 });
    expect(req.token).toBe('valid-token');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('distinguishes an expired token from a malformed token', async () => {
    const expired = new Error('expired');
    expired.name = 'TokenExpiredError';
    jwt.verify.mockImplementationOnce(() => { throw expired; });
    let result = await authenticateRequest('Bearer expired-token');
    expect(result.res.status).toHaveBeenCalledWith(401);
    expect(result.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: '토큰이 만료되었습니다.' }),
    );

    jwt.verify.mockImplementationOnce(() => { throw new Error('invalid signature'); });
    result = await authenticateRequest('Bearer forged-token');
    expect(result.res.status).toHaveBeenCalledWith(401);
    expect(result.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: '유효하지 않은 토큰입니다.' }),
    );
  });

  it('rejects a logged-out token', async () => {
    isTokenBlacklisted.mockResolvedValue(true);
    const { res, next } = await authenticateRequest('Bearer logged-out-token');

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: '이미 로그아웃된 토큰입니다.' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the blacklist store is unavailable', async () => {
    isTokenBlacklisted.mockRejectedValue(new Error('redis connection failed'));
    const { res, next } = await authenticateRequest('Bearer valid-token');

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: {},
      error: '인증 상태를 확인할 수 없습니다.',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
