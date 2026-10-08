const { createHash, randomBytes, randomUUID } = require('crypto');
const prisma = require('../models/prismaClient');

const DEFAULT_TTL_DAYS = 30;
const COOKIE_NAME = 'focuslens_refresh_token';

const getTtlDays = () => {
  const parsed = Number.parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
};

const getTtlMs = () => getTtlDays() * 24 * 60 * 60 * 1000;
const hashRefreshToken = (token) => createHash('sha256').update(token).digest('hex');

const buildRefreshToken = (userId, familyId = randomUUID()) => {
  const rawToken = randomBytes(32).toString('base64url');
  return {
    rawToken,
    data: {
      user_id: userId,
      token_hash: hashRefreshToken(rawToken),
      family_id: familyId,
      expires_at: new Date(Date.now() + getTtlMs()),
    },
  };
};

const issueRefreshToken = async (userId, db = prisma) => {
  const token = buildRefreshToken(userId);
  await db.refresh_tokens.create({ data: token.data });
  return token;
};

const runSerializableTransaction = async (operation, maxAttempts = 3) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (err.code !== 'P2034' || attempt === maxAttempts) throw err;
    }
  }
  throw new Error('Refresh Token 트랜잭션을 완료하지 못했습니다.');
};

const parseCookies = (cookieHeader = '') => cookieHeader
  .split(';')
  .map((part) => part.trim())
  .filter(Boolean)
  .reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_err) {
      cookies[name] = value;
    }
    return cookies;
  }, {});

const getRefreshTokenFromRequest = (req) => (
  req.body?.refresh_token || parseCookies(req.headers?.cookie)[COOKIE_NAME] || null
);

const getCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.REFRESH_COOKIE_SAME_SITE || 'lax',
  maxAge: getTtlMs(),
  path: '/api/auth',
  ...(process.env.REFRESH_COOKIE_DOMAIN && { domain: process.env.REFRESH_COOKIE_DOMAIN }),
});

const setRefreshCookie = (res, token) => {
  if (typeof res.cookie === 'function') res.cookie(COOKIE_NAME, token, getCookieOptions());
};

const clearRefreshCookie = (res) => {
  if (typeof res.clearCookie === 'function') {
    const { maxAge: ignored, ...options } = getCookieOptions();
    res.clearCookie(COOKIE_NAME, options);
  }
};

const rotateRefreshToken = async (rawToken) => runSerializableTransaction(async (tx) => {
  const now = new Date();
  const stored = await tx.refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(rawToken) },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, status: true, deleted_at: true },
      },
    },
  });

  if (!stored) return { status: 'INVALID' };

  if (stored.used_at || stored.replaced_by_token_id) {
    await tx.refresh_tokens.updateMany({
      where: { family_id: stored.family_id, revoked_at: null },
      data: { revoked_at: now },
    });
    return { status: 'REUSED' };
  }

  if (stored.revoked_at || stored.expires_at <= now) return { status: 'INVALID' };
  if (stored.user.status !== 'ACTIVE' || stored.user.deleted_at) {
    await tx.refresh_tokens.updateMany({
      where: { family_id: stored.family_id, revoked_at: null },
      data: { revoked_at: now },
    });
    return { status: 'INVALID' };
  }

  const claimed = await tx.refresh_tokens.updateMany({
    where: {
      id: stored.id,
      used_at: null,
      revoked_at: null,
      expires_at: { gt: now },
    },
    data: { used_at: now, revoked_at: now },
  });

  if (claimed.count !== 1) {
    await tx.refresh_tokens.updateMany({
      where: { family_id: stored.family_id, revoked_at: null },
      data: { revoked_at: now },
    });
    return { status: 'REUSED' };
  }

  const nextToken = buildRefreshToken(stored.user_id, stored.family_id);
  const created = await tx.refresh_tokens.create({ data: nextToken.data, select: { id: true } });
  await tx.refresh_tokens.update({
    where: { id: stored.id },
    data: { replaced_by_token_id: created.id },
  });

  return { status: 'ROTATED', rawToken: nextToken.rawToken, user: stored.user };
});

const revokeRefreshTokensForLogout = async (userId, rawToken) => {
  const now = new Date();
  if (!rawToken) {
    await prisma.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: now },
    });
    return;
  }

  const stored = await prisma.refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(rawToken) },
    select: { user_id: true, family_id: true },
  });
  if (!stored || stored.user_id !== userId) return;

  await prisma.refresh_tokens.updateMany({
    where: { family_id: stored.family_id, revoked_at: null },
    data: { revoked_at: now },
  });
};

module.exports = {
  COOKIE_NAME,
  buildRefreshToken,
  clearRefreshCookie,
  getRefreshTokenFromRequest,
  hashRefreshToken,
  issueRefreshToken,
  revokeRefreshTokensForLogout,
  rotateRefreshToken,
  setRefreshCookie,
};
