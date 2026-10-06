jest.mock('../../backend/src/models/prismaClient', () => ({
  sessions: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  concentration_logs: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
  reports: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
}));
jest.mock('../../backend/src/services/sessionStats', () => ({
  getSessionMetricMap: jest.fn(),
  getSessionTimeline: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const sessionStats = require('../../backend/src/services/sessionStats');
const sessionsController = require('../../backend/src/controllers/sessionsController');

beforeEach(() => {
  sessionStats.getSessionMetricMap.mockResolvedValue(new Map());
  sessionStats.getSessionTimeline.mockResolvedValue([]);
});

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
    prisma.$transaction.mockImplementation((operation) => operation(prisma));
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

describe('session ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects another user reading a session', async () => {
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'owner-id',
      concentration_logs: [],
    });
    const req = { user: { sub: 'attacker-id' }, params: { id: 'session-id' } };
    const res = createResponse();
    const next = jest.fn();

    await sessionsController.getSession(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, message: '세션에 대한 권한이 없습니다.' }),
    );
  });

  it('uses the common average and duration rules in session detail', async () => {
    const startedAt = new Date('2026-10-02T00:00:00.000Z');
    const endedAt = new Date('2026-10-02T00:02:00.900Z');
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'owner-id',
      started_at: startedAt,
      ended_at: endedAt,
      status: 'COMPLETED',
    });
    sessionStats.getSessionMetricMap.mockResolvedValue(new Map([
      ['session-id', { avg_focus_score: 50 }],
    ]));
    const req = { user: { sub: 'owner-id' }, params: { id: 'session-id' } };
    const res = createResponse();
    const next = jest.fn();

    await sessionsController.getSession(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ avg_focus_score: 50, duration_seconds: 120 }),
      }),
    );
  });
});

describe('session end report transaction', () => {
  const startedAt = new Date('2026-10-02T00:00:00.000Z');
  const endedAt = new Date('2026-10-02T00:03:00.500Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(endedAt);
    prisma.$transaction.mockImplementation((operation) => operation(prisma));
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'user-id',
      started_at: startedAt,
      status: 'IN_PROGRESS',
    });
    prisma.sessions.update.mockResolvedValue({
      id: 'session-id',
      ended_at: endedAt,
      status: 'COMPLETED',
    });
    prisma.reports.create.mockResolvedValue({ id: 'report-id' });
  });

  afterEach(() => jest.useRealTimers());

  const endSession = async () => {
    const req = { user: { sub: 'user-id' }, params: { id: 'session-id' } };
    const res = createResponse();
    const next = jest.fn();
    await sessionsController.endSession(req, res, next);
    return { res, next };
  };

  it('creates an empty-session report with null averages and zero state counts', async () => {
    prisma.concentration_logs.findMany.mockResolvedValue([]);

    const { res, next } = await endSession();

    expect(next).not.toHaveBeenCalled();
    const summary = res.json.mock.calls[0][0].data.summary;
    expect(summary).toEqual({
      avg_focus_score: null,
      duration_seconds: 180,
      gaze_avg: null,
      blink_avg: null,
      head_avg: null,
      focused_minutes: 0,
      normal_minutes: 0,
      distracted_minutes: 0,
      total_logs: 0,
    });
    expect(prisma.reports.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { session_id: 'session-id', summary_json: summary } }),
    );
  });

  it('includes zero and multiple logs in weighted averages and state counts', async () => {
    prisma.concentration_logs.findMany.mockResolvedValue([
      { gaze_score: 0, blink_score: 0, head_score: 0, focus_score: 0, attention_state: 'DISTRACTED' },
      { gaze_score: 60, blink_score: 60, head_score: 60, focus_score: 60, attention_state: 'NORMAL' },
      { gaze_score: 90, blink_score: 90, head_score: 90, focus_score: 90, attention_state: 'FOCUSED' },
    ]);

    const { res, next } = await endSession();

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.summary).toEqual({
      avg_focus_score: 50,
      duration_seconds: 180,
      gaze_avg: 50,
      blink_avg: 50,
      head_avg: 50,
      focused_minutes: 1,
      normal_minutes: 1,
      distracted_minutes: 1,
      total_logs: 3,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('does not return a completed response when report creation fails in the transaction', async () => {
    prisma.concentration_logs.findMany.mockResolvedValue([]);
    const failure = new Error('report insert failed');
    prisma.reports.create.mockRejectedValue(failure);

    const { res, next } = await endSession();

    expect(prisma.sessions.update).toHaveBeenCalled();
    expect(prisma.reports.create).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(failure);
  });
});

describe('concentration log idempotency', () => {
  const startedAt = new Date('2026-09-30T00:00:00.000Z');
  const receivedAt = new Date('2026-09-30T00:01:05.000Z');
  const session = {
    id: 'session-id',
    user_id: 'user-id',
    started_at: startedAt,
    status: 'IN_PROGRESS',
  };
  const payload = {
    gaze: 80,
    blink: 70,
    head: 90,
    total: 80,
    face_detected: true,
  };
  const storedLog = {
    id: 'log-id',
    minute_index: 1,
    logged_at: receivedAt,
    gaze_score: 80,
    blink_score: 70,
    head_score: 90,
    focus_score: 80,
    attention_state: 'FOCUSED',
    face_detected: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(receivedAt);
    prisma.$transaction.mockImplementation((operation) => operation(prisma));
    prisma.sessions.findUnique.mockResolvedValue(session);
    prisma.concentration_logs.findUnique.mockResolvedValue(null);
    prisma.concentration_logs.create.mockResolvedValue(storedLog);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const sendLog = async (body = payload) => {
    const req = { user: { sub: 'user-id' }, params: { id: 'session-id' }, body };
    const res = createResponse();
    const next = jest.fn();
    await sessionsController.logConcentration(req, res, next);
    return { res, next };
  };

  it('requires face_detected without accessing the database', async () => {
    const { face_detected: ignored, ...body } = payload;
    const { res, next } = await sendLog(body);

    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'face_detected는 필수 boolean이어야 합니다.' }),
    );
  });

  it('requires every score to be zero when a face was not detected', async () => {
    const { res, next } = await sendLog({ ...payload, face_detected: false });

    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'face_detected가 false이면 모든 점수는 0이어야 합니다.' }),
    );
  });

  it('rejects a log before the first server-side minute has completed', async () => {
    jest.setSystemTime(new Date('2026-09-30T00:00:59.999Z'));
    const { res, next } = await sendLog();

    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.concentration_logs.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: '첫 1분 측정 구간이 아직 완료되지 않았습니다.' }),
    );
  });

  it('normalizes scores and stores a server-derived minute index', async () => {
    const normalizedLog = {
      ...storedLog,
      gaze_score: 33.34,
      blink_score: 66.67,
      head_score: 100,
      focus_score: 63.34,
    };
    prisma.concentration_logs.create.mockResolvedValue(normalizedLog);

    const { res, next } = await sendLog({
      gaze: 33.335,
      blink: 66.665,
      head: 99.999,
      total: 63.34,
      face_detected: true,
    });

    expect(next).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.concentration_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          session_id: 'session-id',
          minute_index: 1,
          logged_at: receivedAt,
          gaze_score: 33.34,
          blink_score: 66.67,
          head_score: 100,
          focus_score: 63.34,
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        log_id: 'log-id',
        minute_index: 1,
        logged_at: receivedAt,
        focus_score: 63.34,
        attention_state: 'FOCUSED',
        face_detected: true,
      },
      error: '',
    });
  });

  it('returns the existing row for the same normalized log in the same minute', async () => {
    prisma.concentration_logs.findUnique.mockResolvedValue(storedLog);
    const { res, next } = await sendLog();

    expect(next).not.toHaveBeenCalled();
    expect(prisma.concentration_logs.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        log_id: 'log-id',
        minute_index: 1,
        logged_at: receivedAt,
        focus_score: 80,
        attention_state: 'FOCUSED',
        face_detected: true,
      },
      error: '',
    });
  });

  it('returns 409 for different content in the same minute', async () => {
    prisma.concentration_logs.findUnique.mockResolvedValue({ ...storedLog, gaze_score: 79 });
    const { res, next } = await sendLog();

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: '같은 분 구간에 다른 로그가 이미 존재합니다.' }),
    );
  });

  it('resolves a concurrent unique conflict to the existing identical row', async () => {
    prisma.concentration_logs.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedLog);
    prisma.concentration_logs.create.mockRejectedValue({ code: 'P2002' });
    const { res, next } = await sendLog();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ log_id: 'log-id', minute_index: 1 }) }),
    );
  });

  it('retries a serialization conflict and rejects the log if the session ended', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((operation) => operation(prisma));
    prisma.sessions.findUnique.mockResolvedValue({ ...session, status: 'COMPLETED' });
    const { res, next } = await sendLog();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: '종료된 세션에는 로그를 추가할 수 없습니다.' }),
    );
  });
});
