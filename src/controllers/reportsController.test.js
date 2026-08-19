jest.mock('../../backend/src/models/prismaClient', () => ({
  sessions: {
    findMany: jest.fn(),
  },
}));

const prisma = require('../../backend/src/models/prismaClient');
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
  started_at: new Date('2026-08-19T09:00:00.000Z'),
  ended_at: new Date('2026-08-19T10:00:00.000Z'),
  concentration_logs: [
    { focus_score: 80, logged_at: new Date('2026-08-19T09:01:00.000Z') },
  ],
};

describe('period reports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.sessions.findMany.mockResolvedValue([completedSession]);
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
          }),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const response = res.json.mock.calls[0][0];
      expect(response.data.daily_summaries).toHaveLength(expectedDays);
      expect(response.data[averageField]).toBe(80);
    },
  );
});
