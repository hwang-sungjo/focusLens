const { EventEmitter } = require('node:events');
const { createShutdownHandler } = require('../../backend/src/services/shutdown');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const fixture = ({ closeImmediately = true, ...overrides } = {}) => {
  const server = new EventEmitter();
  server.close = jest.fn(callback => {
    server.closed = callback;
    if (closeImmediately) callback();
  });
  server.closeIdleConnections = jest.fn();
  server.closeAllConnections = jest.fn();
  const dependencies = {
    server,
    stopScheduler: jest.fn().mockResolvedValue(),
    prisma: { $disconnect: jest.fn().mockResolvedValue() },
    redis: { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() },
    timeoutMs: 100,
    exit: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
  return { ...dependencies, shutdown: createShutdownHandler(dependencies) };
};

describe('bounded graceful server shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drains requests and the current Roll-up before disconnecting shared dependencies', async () => {
    const activeRollup = deferred();
    const state = fixture({ closeImmediately: false, stopScheduler: jest.fn(() => activeRollup.promise) });
    const completion = state.shutdown('SIGTERM');
    expect(state.shutdown('SIGINT')).toBe(completion);
    expect(state.server.close).toHaveBeenCalledTimes(1);
    expect(state.server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(state.stopScheduler).toHaveBeenCalledTimes(1);
    state.server.closed();
    await flush();
    expect(state.prisma.$disconnect).not.toHaveBeenCalled();
    expect(state.redis.quit).not.toHaveBeenCalled();
    activeRollup.resolve();
    await expect(completion).resolves.toBe(0);
    expect(state.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(state.redis.quit).toHaveBeenCalledTimes(1);
    expect(state.exit).toHaveBeenCalledWith(0);
    expect(state.log.mock.calls.filter(([event]) => event === 'server_shutdown_resource_closed')
      .map(([, fields]) => fields.component).sort()).toEqual(['http', 'postgres', 'redis', 'rollup_scheduler']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disconnects a failed Redis connection and still exits cleanly without logging connection secrets', async () => {
    const error = new Error('redis://private-user:secret@private-host');
    const state = fixture({ redis: { quit: jest.fn().mockRejectedValue(error), disconnect: jest.fn() } });
    await expect(state.shutdown('SIGTERM')).resolves.toBe(0);
    expect(state.redis.disconnect).toHaveBeenCalledTimes(1);
    expect(state.log).toHaveBeenCalledWith('server_shutdown_resource_closed', { component: 'redis', method: 'disconnect' });
    expect(JSON.stringify(state.log.mock.calls)).not.toContain('private-user');
  });

  it('attempts every dependency cleanup when Prisma disconnect fails', async () => {
    const state = fixture({ prisma: { $disconnect: jest.fn().mockRejectedValue(new Error('private SQL')) } });
    await expect(state.shutdown('SIGINT')).resolves.toBe(1);
    expect(state.redis.quit).toHaveBeenCalledTimes(1);
    expect(state.log).toHaveBeenCalledWith('server_shutdown_error', {
      component: 'database_disconnect', error_name: 'Error', error_code: null,
    }, 'error');
    expect(JSON.stringify(state.log.mock.calls)).not.toContain('private SQL');
  });

  it('force-closes sockets and dependencies when a request and Roll-up exceed the deadline', async () => {
    const activeRollup = deferred();
    const state = fixture({ closeImmediately: false, stopScheduler: jest.fn(() => activeRollup.promise) });
    const socket = new EventEmitter();
    socket.destroy = jest.fn();
    state.server.emit('connection', socket);
    const completion = state.shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(100);
    await expect(completion).resolves.toBe(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(state.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(state.redis.disconnect).toHaveBeenCalledTimes(1);
    expect(state.prisma.$disconnect).toHaveBeenCalledTimes(1);
    state.server.closed();
    activeRollup.resolve();
    await flush();
    expect(state.exit).toHaveBeenCalledTimes(1);
    expect(state.redis.quit).not.toHaveBeenCalled();
    expect(state.prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds a Redis quit call that never settles', async () => {
    const state = fixture({ redis: { quit: jest.fn(() => new Promise(() => {})), disconnect: jest.fn() } });
    const completion = state.shutdown('SIGTERM');
    await flush();
    expect(state.redis.quit).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    await expect(completion).resolves.toBe(1);
    expect(state.redis.disconnect).toHaveBeenCalledTimes(1);
    expect(state.exit).toHaveBeenCalledTimes(1);
  });

  it('cleans up after startup fails before HTTP begins listening', async () => {
    const state = fixture({ closeImmediately: false });
    const completion = state.shutdown('startup_error', 1);
    state.server.closed(Object.assign(new Error('not listening'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    await expect(completion).resolves.toBe(1);
    expect(state.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(state.redis.quit).toHaveBeenCalledTimes(1);
  });
});
