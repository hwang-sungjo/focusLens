jest.mock('../../backend/src/models/prismaClient', () => ({
  groups: {
    findFirst: jest.fn(),
  },
  group_members: {
    findUnique: jest.fn(),
  },
  users: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require('../../backend/src/models/prismaClient');
const groupsController = require('../../backend/src/controllers/groupsController');

const tx = {
  group_invitations: {
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
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

describe('group invitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.groups.findFirst.mockResolvedValue({ id: 'group-id' });
    prisma.group_members.findUnique.mockImplementation(({ where }) => {
      const { user_id: userId } = where.group_id_user_id;
      if (userId === 'owner-user-id') {
        return Promise.resolve({ id: 'owner-member-id', group_role: 'OWNER', status: 'ACTIVE' });
      }
      return Promise.resolve(null);
    });
    prisma.users.findFirst.mockResolvedValue({
      id: 'invitee-user-id',
      email: 'invitee@example.com',
    });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    tx.group_invitations.updateMany.mockResolvedValue({ count: 1 });
    tx.group_invitations.findFirst.mockResolvedValue(null);
    tx.group_invitations.create.mockResolvedValue({
      id: 'new-invitation-id',
      invite_code: 'new-invite-code',
      invitee_email: null,
      invitee_user_id: 'invitee-user-id',
      status: 'PENDING',
      expires_at: new Date('2026-08-26T00:00:00.000Z'),
      created_at: new Date('2026-08-19T00:00:00.000Z'),
    });
  });

  it('expires stale pending invitations before creating a replacement', async () => {
    const req = {
      user: { sub: 'owner-user-id' },
      params: { id: 'group-id' },
      body: { invitee_user_id: 'invitee-user-id' },
    };
    const res = createResponse();
    const next = jest.fn();

    await groupsController.inviteMember(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.group_invitations.updateMany).toHaveBeenCalledWith({
      where: {
        group_id: 'group-id',
        status: 'PENDING',
        expires_at: { lte: expect.any(Date) },
        OR: [{ invitee_user_id: 'invitee-user-id' }],
      },
      data: { status: 'EXPIRED' },
    });
    expect(tx.group_invitations.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.group_invitations.create.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ invitation_id: 'new-invitation-id' }),
      }),
    );
  });

  it('keeps a valid pending invitation and returns 409', async () => {
    tx.group_invitations.findFirst.mockResolvedValue({ id: 'active-invitation-id' });
    const req = {
      user: { sub: 'owner-user-id' },
      params: { id: 'group-id' },
      body: { invitee_user_id: 'invitee-user-id' },
    };
    const res = createResponse();
    const next = jest.fn();

    await groupsController.inviteMember(req, res, next);

    expect(tx.group_invitations.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: '이미 처리 대기 중인 초대가 있습니다.',
      }),
    );
  });
});
