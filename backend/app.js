// app.js — Express 앱 설정 (라우터 마운트, 미들웨어 등록)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRouter = require('./src/routes/auth');
const sessionsRouter = require('./src/routes/sessions');
const reportsRouter = require('./src/routes/reports');
const usersRouter = require('./src/routes/users');
const connectionsRouter = require('./src/routes/connections');
const sessionSharesRouter = require('./src/routes/sessionShares');
const rankingsRouter = require('./src/routes/rankings');
const groupsRouter = require('./src/routes/groups');

const { notFound, errorHandler } = require('./src/middleware/errorHandler');
const prisma = require('./src/models/prismaClient');
const { redis } = require('./src/services/redis');

const app = express();

// ── 기본 미들웨어 ──────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health Check ───────────────────────────────────────────────────
// DB·Redis를 실제로 ping해서 연결 상태를 확인
// 어느 한쪽이 실패해도 서버 자체는 살아있으므로 HTTP 200 유지,
// 실패한 서비스는 "disconnected"로 표기 (모니터링/알림 시스템에서 data 필드로 판단)
app.get('/health', async (_req, res) => {
  const [dbStatus, redisStatus] = await Promise.all([
    // PostgreSQL ping
    prisma.$queryRaw`SELECT 1`
      .then(() => 'connected')
      .catch(() => 'disconnected'),

    // Redis ping
    redis.ping()
      .then((reply) => (reply === 'PONG' ? 'connected' : 'disconnected'))
      .catch(() => 'disconnected'),
  ]);

  const allHealthy = dbStatus === 'connected' && redisStatus === 'connected';

  return res.status(allHealthy ? 200 : 503).json({
    success: allHealthy,
    data: {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db: dbStatus,
      redis: redisStatus,
    },
    error: allHealthy ? '' : '일부 서비스에 연결할 수 없습니다.',
  });
});

// ── API 라우터 마운트 ──────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/users', usersRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/session-shares', sessionSharesRouter);
app.use('/api/rankings', rankingsRouter);
app.use('/api/groups', groupsRouter);

// ── 에러 핸들러 (라우터 등록 후 반드시 마지막에 위치) ───────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
