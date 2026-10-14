const { runRollup } = require('./rollup');
const { logEvent, recordMetric } = require('./observability');

const DAY_MS = 24 * 60 * 60 * 1000;

const getNextRunAt = (now, hourUtc) => {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0,
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const startRollupScheduler = ({ run = runRollup, now = () => new Date() } = {}) => {
  if (process.env.ROLLUP_ENABLED !== 'true') return null;

  const hourUtc = Number(process.env.ROLLUP_SCHEDULE_HOUR_UTC || '0');
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error('ROLLUP_SCHEDULE_HOUR_UTC must be an integer between 0 and 23');
  }

  let timer;
  let stopped = false;
  const scheduleNext = () => {
    if (stopped) return;
    const current = now();
    const delay = Math.min(getNextRunAt(current, hourUtc).getTime() - current.getTime(), DAY_MS);
    timer = setTimeout(async () => {
      try {
        const result = await run();
        recordMetric('rollup_runs_total', { result: 'success' });
        logEvent('rollup_completed', { result });
      } catch (error) {
        recordMetric('rollup_runs_total', { result: 'failure' });
        logEvent('rollup_failed', {
          error_name: error.name,
          error_code: error.code ?? null,
          message: process.env.NODE_ENV === 'production' ? 'rollup_failed' : error.message,
        }, 'error');
      } finally {
        scheduleNext();
      }
    }, delay);
    timer.unref?.();
  };

  scheduleNext();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

module.exports = { getNextRunAt, startRollupScheduler };
