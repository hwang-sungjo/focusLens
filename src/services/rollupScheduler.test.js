jest.mock('../../backend/src/services/rollup', () => ({ runRollup: jest.fn() }));
jest.mock('../../backend/src/services/observability', () => ({ logEvent: jest.fn(), recordMetric: jest.fn() }));

const { startRollupScheduler, getNextRunAt } = require('../../backend/src/services/rollupScheduler');
const { recordMetric } = require('../../backend/src/services/observability');

describe('Roll-up scheduler lifecycle', () => {
  const environment = { ...process.env };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-25T23:59:59.000Z'));
    process.env.ROLLUP_ENABLED = 'true';
    process.env.ROLLUP_SCHEDULE_HOUR_UTC = '0';
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...environment };
    jest.useRealTimers();
  });

  it('stops the next timer and waits for a currently running Roll-up', async () => {
    let complete;
    const run = jest.fn(() => new Promise(resolve => { complete = resolve; }));
    const stop = startRollupScheduler({ run });
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    const stopped = stop();
    let settled = false;
    stopped.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete({ deleted_rows: 0 });
    await stopped;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels pending work before it begins, including repeated stop calls', async () => {
    const run = jest.fn();
    const stop = startRollupScheduler({ run });
    await Promise.all([stop(), stop()]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('can finish stopping a failed in-flight Roll-up without scheduling another run', async () => {
    let fail;
    const stop = startRollupScheduler({ run: () => new Promise((_resolve, reject) => { fail = reject; }) });
    await jest.advanceTimersByTimeAsync(1000);
    const stopped = stop();
    fail(new Error('database temporarily unavailable'));
    await expect(stopped).resolves.toBeUndefined();
    expect(recordMetric).toHaveBeenCalledWith('rollup_runs_total', { result: 'failure' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves disabled scheduling idle and handles the exact UTC boundary', () => {
    process.env.ROLLUP_ENABLED = 'false';
    expect(startRollupScheduler()).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(getNextRunAt(new Date('2026-11-26T00:00:00.000Z'), 0)).toEqual(new Date('2026-11-27T00:00:00.000Z'));
  });
});
