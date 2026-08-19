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

    const receiver = await prisma.users.findFirst({
      where: { id: receiver_user_id, status: 'ACTIVE', deleted_at: null },
      select: { id: true },
    });
    if (!receiver) return next(createError('대상 사용자를 찾을 수 없습니다.', 404));

    const [userAId, userBId] = [requesterId, receiver_user_id].sort();
    const connection = await prisma.user_connections.findUnique({
      where: { user_a_id_user_b_id: { user_a_id: userAId, user_b_id: userBId } },
      select: { id: true },
    });
    if (connection) return next(createError('이미 친구 관계입니다.', 409));

    const pendingRequest = await prisma.user_connection_requests.findFirst({
      where: {
        OR: [
          { requester_user_id: requesterId, receiver_user_id },
          { requester_user_id: receiver_user_id, receiver_user_id: requesterId },
        ],
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (pendingRequest) return next(createError('이미 처리 대기 중인 요청이 있습니다.', 409));

    const request = await prisma.user_connection_requests.create({
      data: { requester_user_id: requesterId, receiver_user_id, status: 'PENDING' },
      select: {
        id: true,
        requester_user_id: true,
        receiver_user_id: true,
        status: true,
        created_at: true,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        request_id: request.id,
        requester_user_id: request.requester_user_id,
        receiver_user_id: request.receiver_user_id,
        status: request.status,
        created_at: request.created_at,
      },
      error: '',
    });
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
    if (!connectionRequest) return next(createError('친구 요청을 찾을 수 없습니다.', 404));
    if (connectionRequest.status !== 'PENDING') return next(createError('이미 처리된 요청입니다.', 409));

    const isCancellation = status === 'CANCELLED';
    const canProcess = isCancellation
      ? connectionRequest.requester_user_id === userId
      : connectionRequest.receiver_user_id === userId;
    if (!canProcess) return next(createError('해당 요청을 처리할 권한이 없습니다.', 403));

    const result = await prisma.$transaction(async (tx) => {
      // PENDING인 행을 먼저 원자적으로 선점해 동시 응답 중 하나만 성공시킨다.
      const transition = await tx.user_connection_requests.updateMany({
        where: { id, status: 'PENDING' },
        data: { status },
      });
      if (transition.count !== 1) {
        throw createError('이미 처리된 요청입니다.', 409);
      }

      let connection = null;

      if (status === 'ACCEPTED') {
        const [userAId, userBId] = [
          connectionRequest.requester_user_id,
          connectionRequest.receiver_user_id,
        ].sort();
        connection = await tx.user_connections.upsert({
          where: { user_a_id_user_b_id: { user_a_id: userAId, user_b_id: userBId } },
          create: { user_a_id: userAId, user_b_id: userBId },
          update: {},
          select: { id: true },
        });
      }

      return { updated: { id, status }, connection };
    });

    return res.status(200).json({
      success: true,
      data: {
        request_id: result.updated.id,
        status: result.updated.status,
        connection_id: result.connection?.id ?? null,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/connections */
const getConnections = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const includePending = req.query.include_pending === 'true';
    const connections = await prisma.user_connections.findMany({
      where: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      orderBy: { created_at: 'desc' },
      include: {
        user_a: {
          select: {
            id: true,
            user_profile: { select: { nickname: true, profile_image_url: true } },
          },
        },
        user_b: {
          select: {
            id: true,
            user_profile: { select: { nickname: true, profile_image_url: true } },
          },
        },
      },
    });

    const serializedConnections = connections.map((connection) => {
      const friend = connection.user_a_id === userId ? connection.user_b : connection.user_a;
      return {
        connection_id: connection.id,
        user_id: friend.id,
        nickname: friend.user_profile?.nickname ?? null,
        profile_image_url: friend.user_profile?.profile_image_url ?? null,
        connected_at: connection.created_at,
      };
    });

    let pendingReceived = [];
    let pendingSent = [];
    if (includePending) {
      const [received, sent] = await Promise.all([
        prisma.user_connection_requests.findMany({
          where: { receiver_user_id: userId, status: 'PENDING' },
          orderBy: { created_at: 'desc' },
          include: {
            requester: {
              select: {
                id: true,
                user_profile: { select: { nickname: true, profile_image_url: true } },
              },
            },
          },
        }),
        prisma.user_connection_requests.findMany({
          where: { requester_user_id: userId, status: 'PENDING' },
          orderBy: { created_at: 'desc' },
          include: {
            receiver: {
              select: {
                id: true,
                user_profile: { select: { nickname: true, profile_image_url: true } },
              },
            },
          },
        }),
      ]);

      pendingReceived = received.map((request) => ({
        request_id: request.id,
        user_id: request.requester.id,
        nickname: request.requester.user_profile?.nickname ?? null,
        profile_image_url: request.requester.user_profile?.profile_image_url ?? null,
        status: request.status,
        created_at: request.created_at,
      }));
      pendingSent = sent.map((request) => ({
        request_id: request.id,
        user_id: request.receiver.id,
        nickname: request.receiver.user_profile?.nickname ?? null,
        profile_image_url: request.receiver.user_profile?.profile_image_url ?? null,
        status: request.status,
        created_at: request.created_at,
      }));
    }

    return res.status(200).json({
      success: true,
      data: {
        connections: serializedConnections,
        pending_received: pendingReceived,
        pending_sent: pendingSent,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { sendRequest, respondRequest, getConnections };
