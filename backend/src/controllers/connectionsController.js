// src/controllers/connectionsController.js
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

/** POST /api/connections/request */
const sendRequest = async (req, res, next) => {
  try {
    const requesterId = req.user.sub;
    const { receiver_user_id } = req.body;

    // 자기 자신 요청 차단
    if (requesterId === receiver_user_id) {
      return res.status(400).json({ success: false, data: {}, error: '자기 자신에게 친구 요청을 보낼 수 없습니다.' });
    }

    // 이미 연결된 관계 중복 요청 차단
    const existing = await prisma.user_connection_requests.findFirst({
      where: {
        OR: [
          { requester_user_id: requesterId, receiver_user_id },
          { requester_user_id: receiver_user_id, receiver_user_id: requesterId },
        ],
        status: { in: ['PENDING', 'ACCEPTED'] },
      },
    });
    if (existing) {
      return res.status(409).json({ success: false, data: {}, error: '이미 연결 요청이 존재하거나 친구 관계입니다.' });
    }

    const request = await prisma.user_connection_requests.create({
      data: { requester_user_id: requesterId, receiver_user_id, status: 'PENDING' },
      select: { id: true, status: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { request }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/connections/:id */
const respondRequest = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id } = req.params;
    const { status } = req.body;

    const connectionRequest = await prisma.user_connection_requests.findUnique({ where: { id } });
    if (!connectionRequest) return next(createError('요청을 찾을 수 없습니다.', 404));
    if (connectionRequest.receiver_user_id !== userId) return next(createError('권한이 없습니다.', 403));
    if (connectionRequest.status !== 'PENDING') return next(createError('이미 처리된 요청입니다.', 400));

    const updated = await prisma.user_connection_requests.update({
      where: { id },
      data: { status },
      select: { id: true, status: true },
    });

    // 수락 시 user_connections에 양방향 레코드 생성
    if (status === 'ACCEPTED') {
      const [a, b] = [connectionRequest.requester_user_id, userId].sort();
      await prisma.user_connections.upsert({
        where: { user_a_id_user_b_id: { user_a_id: a, user_b_id: b } },
        create: { user_a_id: a, user_b_id: b },
        update: {},
      });
    }

    return res.status(200).json({ success: true, data: { request: updated }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/connections */
const getConnections = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const connections = await prisma.user_connections.findMany({
      where: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      include: {
        users_user_connections_user_a_idTousers: { select: { id: true, name: true } },
        users_user_connections_user_b_idTousers: { select: { id: true, name: true } },
      },
    });

    const friends = connections.map((c) =>
      c.user_a_id === userId
        ? c.users_user_connections_user_b_idTousers
        : c.users_user_connections_user_a_idTousers,
    );

    return res.status(200).json({ success: true, data: { friends }, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { sendRequest, respondRequest, getConnections };
