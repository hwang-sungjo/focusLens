jest.mock('../../backend/src/models/prismaClient', () => ({
  sessions: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
}));
jest.mock('../../backend/src/services/sessionStats', () => ({
  getSessionMetricMap: jest.fn(),
  getSessionTimeline: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const sessionStats = require('../../backend/src/services/sessionStats');
const reportsController = require('../../backend/src/controllers/reportsController');

const createResponse = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

const completedSession = {
  id: 'session-id',
  started_at: new Date('2026-08-19T09:00:00.000Z'),
  ended_at: new Date('2026-08-19T10:00:00.000Z'),
};

describe('period reports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.sessions.findMany.mockResolvedValue([completedSession]);
    sessionStats.getSessionMetricMap.mockResolvedValue(new Map([
      ['session-id', { focus_score_sum: 80, log_count: 1 }],
    ]));
    sessionStats.getSessionTimeline.mockResolvedValue([]);
  });

  it.each([
    ['weekly', reportsController.getWeeklyReport, 7, 'weekly_avg_focus_score'],
    ['monthly', reportsController.getMonthlyReport, 30, 'monthly_avg_focus_score'],
  ])(
    '%s report queries only completed sessions',
    async (_period, handler, expectedDays, averageField) => {
      const req = {
        user: { sub: 'user-id' },
        query: { end_date: '2026-08-19' },
      };
      const res = createResponse();
      const next = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(prisma.sessions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user_id: 'user-id',
            status: 'COMPLETED',
            ended_at: { not: null },
          }),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const response = res.json.mock.calls[0][0];
      expect(response.data.daily_summaries).toHaveLength(expectedDays);
      expect(response.data[averageField]).toBe(80);
    },
  );

  it('returns every empty UTC date across leap day and month end', async () => {
    prisma.sessions.findMany.mockResolvedValue([]);
    const req = { user: { sub: 'user-id' }, query: { end_date: '2024-03-01' } };
    const res = createResponse();
    const next = jest.fn();

    await reportsController.getMonthlyReport(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.sessions.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          started_at: {
            gte: new Date('2024-02-01T00:00:00.000Z'),
            lte: new Date('2024-03-01T23:59:59.999Z'),
          },
        }),
      }),
    );
    const data = res.json.mock.calls[0][0].data;
    expect(data.period).toEqual({ start_date: '2024-02-01', end_date: '2024-03-01' });
    expect(data.daily_summaries).toHaveLength(30);
    expect(data.daily_summaries[0]).toEqual({
      date: '2024-02-01',
      session_count: 0,
      total_study_seconds: 0,
      avg_focus_score: null,
    });
    expect(data.daily_summaries.some((day) => day.date === '2024-02-29')).toBe(true);
    expect(data.daily_summaries.at(-1).date).toBe('2024-03-01');
    expect(data.monthly_avg_focus_score).toBeNull();
    expect(data.monthly_total_study_seconds).toBe(0);
  });

  it('assigns a cross-midnight session and all of its logs to its UTC start date', async () => {
    prisma.sessions.findMany.mockResolvedValue([{
      id: 'cross-midnight-session',
      started_at: new Date('2024-02-29T23:59:00.000Z'),
      ended_at: new Date('2024-03-01T00:01:00.000Z'),
    }]);
    sessionStats.getSessionMetricMap.mockResolvedValue(new Map([
      ['cross-midnight-session', { focus_score_sum: 100, log_count: 2 }],
    ]));
    const req = { user: { sub: 'user-id' }, query: { end_date: '2024-03-01' } };
    const res = createResponse();
    const next = jest.fn();

    await reportsController.getWeeklyReport(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const data = res.json.mock.calls[0][0].data;
    const startDay = data.daily_summaries.find((day) => day.date === '2024-02-29');
    const nextDay = data.daily_summaries.find((day) => day.date === '2024-03-01');
    expect(startDay).toEqual({
      date: '2024-02-29',
      session_count: 1,
      total_study_seconds: 120,
      avg_focus_score: 50,
    });
    expect(nextDay).toEqual({
      date: '2024-03-01',
      session_count: 0,
      total_study_seconds: 0,
      avg_focus_score: null,
    });
    expect(data.weekly_avg_focus_score).toBe(50);
    const query = prisma.sessions.findMany.mock.calls[0][0];
    expect(query.include).toBeUndefined();
  });

  it('rejects a normalized invalid calendar date', async () => {
    const req = { user: { sub: 'user-id' }, query: { end_date: '2024-02-30' } };
    const res = createResponse();
    const next = jest.fn();

    await reportsController.getWeeklyReport(req, res, next);

    expect(prisma.sessions.findMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'end_date 형식이 올바르지 않습니다.' }),
    );
  });
});

describe('report ownership', () => {
  it('rejects another user before returning report data', async () => {
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'owner-id',
      report: { id: 'report-id', summary_json: { private: true } },
      concentration_logs: [{ focus_score: 99 }],
    });
    const req = { user: { sub: 'attacker-id' }, params: { session_id: 'session-id' } };
    const res = createResponse();
    const next = jest.fn();

    await reportsController.getReport(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, message: '리포트에 대한 권한이 없습니다.' }),
    );
  });

  it('does not return an orphan report for a session that is not completed', async () => {
    prisma.sessions.findUnique.mockResolvedValue({
      id: 'session-id',
      user_id: 'owner-id',
      status: 'IN_PROGRESS',
      ended_at: null,
      report: { id: 'orphan-report-id', summary_json: { invalid: true } },
      concentration_logs: [],
    });
    const req = { user: { sub: 'owner-id' }, params: { session_id: 'session-id' } };
    const res = createResponse();
    const next = jest.fn();

    await reportsController.getReport(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: '리포트가 아직 생성되지 않았습니다.' }),
    );
  });
});
