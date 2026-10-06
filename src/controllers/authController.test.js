jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}), { virtual: true });

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(),
  decode: jest.fn(),
}), { virtual: true });

jest.mock('../../backend/src/models/prismaClient', () => ({
  users: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  user_profiles: {
    findUnique: jest.fn(),
  },
}));

jest.mock('../../backend/src/services/redis', () => ({
  blacklistToken: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../../backend/src/models/prismaClient');
const { blacklistToken } = require('../../backend/src/services/redis');
const authController = require('../../backend/src/controllers/authController');

const createResponse = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

const call = async (handler, req) => {
  const res = createResponse();
  const next = jest.fn();
  await handler(req, res, next);
  return { res, next };
};

describe('authentication controller', () => {
  const activeUser = {
    id: 'user-id',
    email: 'user@example.com',
    name: 'User',
    role: 'USER',
    status: 'ACTIVE',
    deleted_at: null,
    password_hash: 'stored-password-hash',
    created_at: new Date('2026-10-02T00:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    process.env.JWT_EXPIRES_IN = '1h';
    jwt.sign.mockReturnValue('issued-access-token');
    jwt.decode.mockReturnValue({ iat: 100, exp: 3700 });
    prisma.users.findUnique.mockResolvedValue(null);
    prisma.user_profiles.findUnique.mockResolvedValue(null);
    bcrypt.hash.mockResolvedValue('new-password-hash');
    bcrypt.compare.mockResolvedValue(true);
  });

  it('registers a user with hashed credentials and never returns the password hash', async () => {
    prisma.users.create.mockResolvedValue(activeUser);
    const { res, next } = await call(authController.register, {
      body: {
        email: activeUser.email,
        password: 'password123',
        name: activeUser.name,
        nickname: 'tester',
      },
    });

    expect(next).not.toHaveBeenCalled();
    expect(bcrypt.hash).toHaveBeenCalledWith('password123', 12);
    expect(prisma.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          password_hash: 'new-password-hash',
          user_profile: { create: { nickname: 'tester' } },
        }),
      }),
    );
    const response = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(201);
    expect(response.data.access_token).toBe('issued-access-token');
    expect(JSON.stringify(response)).not.toContain('password_hash');
    expect(JSON.stringify(response)).not.toContain('new-password-hash');
  });

  it('logs in an active user without returning the password hash', async () => {
    prisma.users.findUnique.mockResolvedValue(activeUser);
    const { res, next } = await call(authController.login, {
      body: { email: activeUser.email, password: 'password123' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(bcrypt.compare).toHaveBeenCalledWith('password123', 'stored-password-hash');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('password_hash');
  });

  it('uses the same 401 response for an unknown email and a wrong password', async () => {
    let result = await call(authController.login, {
      body: { email: 'unknown@example.com', password: 'wrong-password' },
    });
    const unknownResponse = result.res.json.mock.calls[0][0];

    prisma.users.findUnique.mockResolvedValue(activeUser);
    bcrypt.compare.mockResolvedValue(false);
    result = await call(authController.login, {
      body: { email: activeUser.email, password: 'wrong-password' },
    });
    const wrongPasswordResponse = result.res.json.mock.calls[0][0];

    expect(unknownResponse).toEqual(wrongPasswordResponse);
    expect(wrongPasswordResponse).toEqual({
      success: false,
      data: {},
      error: '이메일 또는 비밀번호가 올바르지 않습니다.',
    });
  });

  it('rejects an inactive user after password verification', async () => {
    prisma.users.findUnique.mockResolvedValue({ ...activeUser, status: 'SUSPENDED' });
    const { res } = await call(authController.login, {
      body: { email: activeUser.email, password: 'password123' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: '비활성화된 계정입니다.' }),
    );
  });

  it('blacklists a logged-out token only for its remaining lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { res, next } = await call(authController.logout, {
      token: 'access-token',
      user: { sub: 'user-id', exp: 1300 },
    });

    expect(next).not.toHaveBeenCalled();
    expect(blacklistToken).toHaveBeenCalledWith('access-token', 300);
    expect(res.status).toHaveBeenCalledWith(200);
    Date.now.mockRestore();
  });

  it('fails closed with 503 when logout cannot update the blacklist', async () => {
    blacklistToken.mockRejectedValue(new Error('redis connection failed'));
    const { res, next } = await call(authController.logout, {
      token: 'access-token',
      user: { sub: 'user-id', exp: Math.floor(Date.now() / 1000) + 300 },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: {},
      error: '인증 상태를 확인할 수 없습니다.',
    });
  });
});
