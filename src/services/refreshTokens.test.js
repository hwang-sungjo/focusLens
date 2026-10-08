jest.mock('../../backend/src/models/prismaClient', () => ({
  refresh_tokens: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const refreshTokens = require('../../backend/src/services/refreshTokens');

describe('refresh token service', () => {
  const now = new Date('2026-10-06T00:00:00.000Z');
  const activeUser = {
    id: 'user-id',
    email: 'user@example.com',
    name: 'User',
    role: 'USER',
    status: 'ACTIVE',
    deleted_at: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    prisma.$transaction.mockImplementation((operation) => operation(prisma));
    prisma.refresh_tokens.create.mockResolvedValue({ id: 'next-token-id' });
    prisma.refresh_tokens.update.mockResolvedValue({});
    prisma.refresh_tokens.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => jest.useRealTimers());

  it('stores only a SHA-256 hash when issuing a refresh token', async () => {
    const issued = await refreshTokens.issueRefreshToken('user-id');

    expect(issued.rawToken).toHaveLength(43);
    const data = prisma.refresh_tokens.create.mock.calls[0][0].data;
    expect(data.user_id).toBe('user-id');
    expect(data.token_hash).toHaveLength(64);
    expect(data.token_hash).not.toBe(issued.rawToken);
    expect(data.expires_at).toEqual(new Date('2026-11-05T00:00:00.000Z'));
  });

  it('atomically claims and rotates a valid token in the same family', async () => {
    const currentToken = 'a'.repeat(43);
    prisma.refresh_tokens.findUnique.mockResolvedValue({
      id: 'current-token-id',
      user_id: 'user-id',
      token_hash: refreshTokens.hashRefreshToken(currentToken),
      family_id: 'family-id',
      expires_at: new Date('2026-11-01T00:00:00.000Z'),
      used_at: null,
      revoked_at: null,
      replaced_by_token_id: null,
      user: activeUser,
    });

    const result = await refreshTokens.rotateRefreshToken(currentToken);

    expect(result.status).toBe('ROTATED');
    expect(result.user).toEqual(activeUser);
    expect(result.rawToken).toHaveLength(43);
    expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'current-token-id',
        used_at: null,
        revoked_at: null,
        expires_at: { gt: now },
      },
      data: { used_at: now, revoked_at: now },
    });
    expect(prisma.refresh_tokens.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ user_id: 'user-id', family_id: 'family-id' }),
      select: { id: true },
    });
    expect(prisma.refresh_tokens.update).toHaveBeenCalledWith({
      where: { id: 'current-token-id' },
      data: { replaced_by_token_id: 'next-token-id' },
    });
  });

  it('revokes the token family when an already rotated token is reused', async () => {
    const currentToken = 'b'.repeat(43);
    prisma.refresh_tokens.findUnique.mockResolvedValue({
      id: 'used-token-id',
      user_id: 'user-id',
      family_id: 'family-id',
      expires_at: new Date('2026-11-01T00:00:00.000Z'),
      used_at: new Date('2026-10-05T00:00:00.000Z'),
      revoked_at: new Date('2026-10-05T00:00:00.000Z'),
      replaced_by_token_id: 'replacement-id',
      user: activeUser,
    });

    const result = await refreshTokens.rotateRefreshToken(currentToken);

    expect(result).toEqual({ status: 'REUSED' });
    expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith({
      where: { family_id: 'family-id', revoked_at: null },
      data: { revoked_at: now },
    });
    expect(prisma.refresh_tokens.create).not.toHaveBeenCalled();
  });

  it('retries a serialization conflict before rotating', async () => {
    const currentToken = 'c'.repeat(43);
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((operation) => operation(prisma));
    prisma.refresh_tokens.findUnique.mockResolvedValue({
      id: 'current-token-id',
      user_id: 'user-id',
      family_id: 'family-id',
      expires_at: new Date('2026-11-01T00:00:00.000Z'),
      used_at: null,
      revoked_at: null,
      replaced_by_token_id: null,
      user: activeUser,
    });

    const result = await refreshTokens.rotateRefreshToken(currentToken);

    expect(result.status).toBe('ROTATED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('revokes every active user token when logout has no refresh token', async () => {
    await refreshTokens.revokeRefreshTokensForLogout('user-id', null);

    expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'user-id', revoked_at: null },
      data: { revoked_at: now },
    });
  });

  it('accepts a refresh token from the HttpOnly cookie transport', () => {
    const request = {
      body: {},
      headers: { cookie: 'other=value; focuslens_refresh_token=cookie-token' },
    };

    expect(refreshTokens.getRefreshTokenFromRequest(request)).toBe('cookie-token');
  });
});
