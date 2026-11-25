const { logEvent } = require('./observability');

// Keep dependencies open until both HTTP requests and the current Roll-up finish.
const createShutdownHandler = ({
  server,
  stopScheduler = () => {},
  prisma,
  redis,
  timeoutMs = 8000,
  exit = code => process.exit(code),
  log = logEvent,
}) => {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Shutdown timeout must be a positive integer.');
  }

  const sockets = new Set();
  const trackSocket = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', trackSocket);
  let completion;
  let requestedExitCode = 0;

  const reportError = (component, error) => log('server_shutdown_error', {
    component,
    error_name: error?.name || 'Error',
    error_code: error?.code || null,
  }, 'error');

  return (reason = 'SIGTERM', exitCode = 0) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (completion) return completion;

    completion = new Promise(resolve => {
      let finished = false;
      let failed = false;
      let deadline;
      const finish = code => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        server.removeListener('connection', trackSocket);
        log('server_shutdown_completed', { reason, exit_code: code });
        resolve(code);
        exit(code);
      };
      const attempt = async (component, operation) => {
        try {
          await operation();
        } catch (error) {
          failed = true;
          reportError(component, error);
        }
      };
      const closed = (component, fields = {}) => log('server_shutdown_resource_closed', { component, ...fields });
      log('server_shutdown_started', { reason, timeout_ms: timeoutMs });
      deadline = setTimeout(() => {
        if (finished) return;
        log('server_shutdown_timeout', { reason, open_connections: sockets.size }, 'error');
        for (const socket of sockets) {
          try { socket.destroy(); } catch (error) { reportError('http_force_close', error); }
        }
        try { server.closeAllConnections?.(); } catch (error) { reportError('http_force_close', error); }
        try { redis.disconnect(); } catch (error) { reportError('redis_force_close', error); }
        // $disconnect may itself be blocked by the failed dependency. Attempt it,
        // then let process exit release the connections within the fixed deadline.
        try {
          Promise.resolve(prisma.$disconnect()).catch(error => reportError('db_force_close', error));
        } catch (error) { reportError('db_force_close', error); }
        finish(1);
      }, timeoutMs);

      const httpClosed = new Promise((resolveHttp, rejectHttp) => {
        try {
          server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectHttp(error);
            else resolveHttp();
          });
          server.closeIdleConnections?.();
        } catch (error) {
          if (error.code === 'ERR_SERVER_NOT_RUNNING') resolveHttp();
          else rejectHttp(error);
        }
      });
      const schedulerStopped = attempt('rollup_scheduler', async () => {
        await stopScheduler();
        closed('rollup_scheduler');
      });
      (async () => {
        await Promise.all([attempt('http_close', async () => {
          await httpClosed;
          closed('http');
        }), schedulerStopped]);
        if (finished) return;
        await Promise.all([
          attempt('database_disconnect', async () => {
            await prisma.$disconnect();
            closed('postgres');
          }),
          attempt('redis_quit', async () => {
            try {
              await redis.quit();
              closed('redis', { method: 'quit' });
            } catch (error) {
              log('server_shutdown_redis_fallback', {
                error_name: error?.name || 'Error',
                error_code: error?.code || null,
              });
              redis.disconnect();
              closed('redis', { method: 'disconnect' });
            }
          }),
        ]);
        if (!finished) finish(failed ? 1 : requestedExitCode);
      })().catch(error => {
        reportError('shutdown', error);
        finish(1);
      });
    });
    return completion;
  };
};

module.exports = { createShutdownHandler };
