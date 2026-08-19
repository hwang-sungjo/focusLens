jest.mock('../../backend/src/models/prismaClient', () => ({
  sessions: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock('../../backend/src/services/redis', () => ({
  acquireLogRateLimit: jest.fn(),
  releaseLogRateLimit: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const sessionsController = require('../../backend/src/controllers/sessionsController');

const createResponse = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe('session start concurrency guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.sessions.findFirst.mockResolvedValue(null);
  });

  it('maps a concurrent active-session unique conflict to 409', async () => {
    prisma.sessions.create.mockRejectedValue({ code: 'P2002' });
    const req = { user: { sub: 'user-id' } };
    const res = createResponse();
    const next = jest.fn();

    await sessionsController.startSession(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: '이미 진행 중인 세션이 있습니다.',
      }),
    );
  });

  it('still creates a session when no active session exists', async () => {
    const startedAt = new Date('2026-08-19T00:00:00.000Z');
    prisma.sessions.create.mockResolvedValue({
      id: 'session-id',
      started_at: startedAt,
      status: 'IN_PROGRESS',
    });
    const req = { user: { sub: 'user-id' } };
    const res = createResponse();
    const next = jest.fn();

    await sessionsController.startSession(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { session_id: 'session-id', started_at: startedAt, status: 'IN_PROGRESS' },
      error: '',
    });
  });
});
