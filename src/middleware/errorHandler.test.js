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
});
