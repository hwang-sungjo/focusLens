jest.mock('../../backend/src/models/prismaClient', () => ({
  users: {
    findFirst: jest.fn(),
  },
  user_connections: {
    findUnique: jest.fn(),
  },
  user_connection_requests: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const connectionsController = require('../../backend/src/controllers/connectionsController');

const tx = {
  user_connection_requests: {
    updateMany: jest.fn(),
  },
  user_connections: {
    upsert: jest.fn(),
  },
};

const createResponse = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

const pendingRequest = {
  id: 'request-id',
  requester_user_id: 'requester-id',
  receiver_user_id: 'receiver-id',
  status: 'PENDING',
};

describe('connection request atomic transition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user_connection_requests.findUnique.mockResolvedValue(pendingRequest);
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    tx.user_connection_requests.updateMany.mockResolvedValue({ count: 1 });
    tx.user_connections.upsert.mockResolvedValue({ id: 'connection-id' });
  });

  it('returns 409 when another response already claimed the pending request', async () => {
    tx.user_connection_requests.updateMany.mockResolvedValue({ count: 0 });
    const req = {
      user: { sub: 'receiver-id' },
      params: { id: 'request-id' },
      body: { status: 'ACCEPTED' },
    };
    const res = createResponse();
    const next = jest.fn();

    await connectionsController.respondRequest(req, res, next);

    expect(tx.user_connection_requests.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-id', status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    expect(tx.user_connections.upsert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: '이미 처리된 요청입니다.',
      }),
    );
  });

  it('claims the request before creating an accepted connection', async () => {
    const req = {
      user: { sub: 'receiver-id' },
      params: { id: 'request-id' },
      body: { status: 'ACCEPTED' },
    };
    const res = createResponse();
    const next = jest.fn();

    await connectionsController.respondRequest(req, res, next);

    expect(tx.user_connection_requests.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user_connections.upsert.mock.invocationCallOrder[0],
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        request_id: 'request-id',
        status: 'ACCEPTED',
        connection_id: 'connection-id',
      },
      error: '',
    });
  });
});

describe('connection request concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.users.findFirst.mockResolvedValue({ id: 'receiver-id' });
    prisma.user_connections.findUnique.mockResolvedValue(null);
    prisma.user_connection_requests.findFirst.mockResolvedValue(null);
  });

  it('maps a concurrent pending-request unique collision to 409', async () => {
    prisma.user_connection_requests.create.mockRejectedValue({ code: 'P2002' });
    const req = {
      user: { sub: 'requester-id' },
      body: { receiver_user_id: 'receiver-id' },
    };
    const res = createResponse();
    const next = jest.fn();

    await connectionsController.sendRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: '이미 처리 대기 중인 요청이 있습니다.',
      }),
    );
    expect(res.status).not.toHaveBeenCalled();
  });
});
