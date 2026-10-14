jest.mock('../../backend/src/models/prismaClient', () => ({
  sessions: { findUnique: jest.fn() },
  user_privacy_settings: { findUnique: jest.fn() },
  groups: { findFirst: jest.fn() },
  group_members: { findUnique: jest.fn(), findMany: jest.fn() },
  user_connections: { findMany: jest.fn() },
  session_shares: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  session_reactions: { create: jest.fn(), deleteMany: jest.fn() },
  $queryRaw: jest.fn(),
}));
jest.mock('../../backend/src/services/sessionStats', () => ({
  getSessionMetricMap: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const sessionStats = require('../../backend/src/services/sessionStats');
const sessionSharesController = require('../../backend/src/controllers/sessionSharesController');

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

describe('session share privacy', () => {
  const completedSession = {
    id: 'session-id',
    user_id: 'owner-id',
    status: 'COMPLETED',
    ended_at: new Date('2026-10-02T00:01:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.sessions.findUnique.mockResolvedValue(completedSession);
    prisma.session_shares.findFirst.mockResolvedValue(null);
    prisma.user_connections.findMany.mockResolvedValue([]);
    prisma.group_members.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.session_shares.count.mockResolvedValue(0);
    sessionStats.getSessionMetricMap.mockResolvedValue(new Map());
  });

  it('blocks a share wider than the owner default scope', async () => {
    prisma.user_privacy_settings.findUnique.mockResolvedValue({ default_session_scope: 'PRIVATE' });
    const { res, next } = await call(sessionSharesController.createShare, {
      user: { sub: 'owner-id' },
      body: { session_id: 'session-id', share_scope: 'PUBLIC', share_message: null },
    });

    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.session_shares.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringContaining('default_session_scope'),
      }),
    );
  });

  it('rejects a completed status without an end timestamp', async () => {
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'owner-id',
      status: 'COMPLETED',
      ended_at: null,
    });

    const { res, next } = await call(sessionSharesController.createShare, {
      user: { sub: 'owner-id' },
      body: { session_id: 'session-id', share_scope: 'PUBLIC' },
    });

    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.user_privacy_settings.findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: '완료되지 않은 세션은 공유할 수 없습니다.' }),
    );
  });

  it('stores and returns markup-like content as an inert string', async () => {
    const content = `\"><script>alert('xss')</script>' OR 1=1 --`;
    prisma.user_privacy_settings.findUnique.mockResolvedValue({ default_session_scope: 'PUBLIC' });
    prisma.session_shares.create.mockResolvedValue({
      id: 'share-id',
      session_id: 'session-id',
      share_scope: 'PUBLIC',
      group_id: null,
      share_message: content,
      status: 'ACTIVE',
      created_at: new Date('2026-10-02T00:00:00.000Z'),
    });
    const { res, next } = await call(sessionSharesController.createShare, {
      user: { sub: 'owner-id' },
      body: { session_id: 'session-id', share_scope: 'PUBLIC', share_message: content },
    });

    expect(next).not.toHaveBeenCalled();
    expect(prisma.session_shares.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ share_message: content }) }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ share_message: content }) }),
    );
  });

  it('masks focus score and study time independently in the feed', async () => {
    const share = {
      id: 'share-id',
      session_id: 'session-id',
      group_id: null,
      share_scope: 'PUBLIC',
      share_message: 'study',
      created_at: new Date('2026-10-02T01:00:00.000Z'),
      reactions: [],
      session: {
        user_id: 'owner-id',
        started_at: new Date('2026-10-02T00:00:00.000Z'),
        ended_at: new Date('2026-10-02T01:00:00.000Z'),
        concentration_logs: [{ focus_score: 80 }, { focus_score: 100 }],
        user: {
          user_profile: { nickname: 'owner', profile_image_url: null },
          user_privacy_settings: {
            default_session_scope: 'PUBLIC',
            score_visibility: 'PRIVATE',
            study_time_visibility: 'PUBLIC',
          },
        },
      },
    };
    prisma.session_shares.findMany.mockResolvedValue([share]);
    prisma.session_shares.count.mockResolvedValue(1);
    const { res, next } = await call(sessionSharesController.getFeed, {
      user: { sub: 'viewer-id' },
      query: {},
    });

    expect(next).not.toHaveBeenCalled();
    expect(prisma.session_shares.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { session: { status: 'COMPLETED', ended_at: { not: null } } },
          ]),
        }),
      }),
    );
    const summary = res.json.mock.calls[0][0].data.feed[0].session_summary;
    expect(summary).toEqual({
      started_at: share.session.started_at,
      duration_seconds: 3600,
      avg_focus_score: null,
    });
  });

  it('removes an existing share from the feed after the owner narrows default scope', async () => {
    prisma.session_shares.findMany.mockResolvedValue([]);
    const { res, next } = await call(sessionSharesController.getFeed, {
      user: { sub: 'viewer-id' },
      query: {},
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { feed: [], pagination: { page: 1, limit: 20, total: 0 } },
      error: '',
    });
  });

  it('maps concurrent duplicate share and reaction constraints to 409', async () => {
    prisma.user_privacy_settings.findUnique.mockResolvedValue({ default_session_scope: 'PUBLIC' });
    prisma.session_shares.create.mockRejectedValueOnce({ code: 'P2002' });
    let result = await call(sessionSharesController.createShare, {
      user: { sub: 'owner-id' },
      body: { session_id: 'session-id', share_scope: 'PUBLIC' },
    });
    expect(result.next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: '동일 범위로 이미 공유된 세션입니다.' }),
    );

    prisma.session_shares.findFirst.mockResolvedValue({
      id: 'share-id',
      group_id: null,
      share_scope: 'PUBLIC',
      session: {
        user_id: 'owner-id',
        user: { user_privacy_settings: { default_session_scope: 'PUBLIC' } },
      },
    });
    prisma.session_reactions.create.mockRejectedValueOnce({ code: 'P2002' });
    result = await call(sessionSharesController.addReaction, {
      user: { sub: 'viewer-id' },
      params: { id: 'share-id' },
      body: { reaction_type: 'LIKE' },
    });
    expect(result.next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: '이미 동일 유형의 반응을 남겼습니다.' }),
    );
    expect(prisma.session_shares.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          session: { status: 'COMPLETED', ended_at: { not: null } },
        }),
      }),
    );
  });
});
