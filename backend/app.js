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

const app = express();

// ── 기본 미들웨어 ──────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health Check ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' }, error: '' });
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
