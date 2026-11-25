const { errorHandler, createError } = require('../../backend/src/middleware/errorHandler');

const createResponse = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('global error response safety', () => {
  let consoleError;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('keeps an intentional client error message', () => {
    const res = createResponse();
    errorHandler(createError('권한이 없습니다.', 403), {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, data: {}, error: '권한이 없습니다.' });
  });

  it.each(['development', 'test', 'production'])(
    'hides SQL and internal details from a 500 response in %s',
    (nodeEnv) => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = nodeEnv;
      const res = createResponse();
      const error = new Error('SELECT password_hash FROM users; database password=secret');

      errorHandler(error, {}, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: {},
        error: '서버 내부 오류가 발생했습니다.',
      });
      process.env.NODE_ENV = previous;
    },
  );

  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])(
    'returns 503 for a temporary database failure %s without exposing connection details',
    (code) => {
      const res = createResponse();
      const err = Object.assign(new Error('postgresql://private:password@db'), { code });
      errorHandler(err, {}, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        success: false, data: {}, error: '데이터베이스에 일시적으로 연결할 수 없습니다.',
      });
    },
  );

  it('handles the errorCode field of a Prisma initialization failure', () => {
    const res = createResponse();
    errorHandler({ name: 'PrismaClientInitializationError', errorCode: 'P1001' }, {}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it.each(['08006', '57P01', '57P02', '57P03'])(
    'returns 503 for raw query connection failure SQLSTATE %s', (code) => {
      const res = createResponse();
      errorHandler({ code: 'P2010', meta: { code } }, {}, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(503);
    },
  );

  it('keeps a raw query syntax failure as 500', () => {
    const res = createResponse();
    errorHandler({ code: 'P2010', meta: { code: '42601' } }, {}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
