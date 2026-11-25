// server.js — HTTP 서버 리스닝
const http = require('node:http');
const app = require('./app');
const { startRollupScheduler } = require('./src/services/rollupScheduler');
const { createShutdownHandler } = require('./src/services/shutdown');
const prisma = require('./src/models/prismaClient');
const { redis } = require('./src/services/redis');
const { logEvent } = require('./src/services/observability');

const PORT = process.env.PORT || 3000;
const configuredTimeout = process.env.SHUTDOWN_TIMEOUT_MS === undefined
  ? 8000 : Number(process.env.SHUTDOWN_TIMEOUT_MS);
const validTimeout = Number.isInteger(configuredTimeout) && configuredTimeout > 0;
const server = http.createServer(app);
let stopScheduler;
const shutdown = createShutdownHandler({
  server,
  stopScheduler: () => stopScheduler?.(),
  prisma,
  redis,
  timeoutMs: validTimeout ? configuredTimeout : 8000,
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const startupFailed = error => {
  logEvent('server_start_failed', {
    error_name: error.name,
    error_code: error.code || null,
  }, 'error');
  void shutdown('startup_error', 1);
};
server.on('error', startupFailed);

try {
  if (!validTimeout) throw new Error('SHUTDOWN_TIMEOUT_MS must be a positive integer');
  // Importing the app for schema checks must not open background connections.
  // The client keeps retrying after an initial failure; health stays degraded meanwhile.
  void redis.connect().catch(() => {});
  server.listen(PORT, () => {
    try {
      stopScheduler = startRollupScheduler();
      logEvent('server_listening', { port: server.address().port, environment: process.env.NODE_ENV || 'development' });
    } catch (error) {
      startupFailed(error);
    }
  });
} catch (error) {
  startupFailed(error);
}
