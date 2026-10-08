const { Prisma } = require('@prisma/client');
const prisma = require('../models/prismaClient');

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_LOCK_ID = 714_204_404;

class RollupVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RollupVerificationError';
  }
}

const floorUtcHour = (date) => {
  const value = new Date(date);
  value.setUTCMinutes(0, 0, 0);
  return value;
};

const floorUtcDay = (date) => {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
};

const floorUtcWeek = (date) => {
  const value = floorUtcDay(date);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value;
};

const getRollupCutoffs = (now = new Date(), retention = {}) => ({
  hourly: floorUtcHour(new Date(now.getTime() - (retention.rawDays ?? 30) * DAY_MS)),
  daily: floorUtcDay(new Date(now.getTime() - (retention.hourlyDays ?? 90) * DAY_MS)),
  weekly: floorUtcWeek(new Date(now.getTime() - (retention.dailyDays ?? 365) * DAY_MS)),
});

const RAW_AGGREGATE = Prisma.raw(`
  SELECT session_id, date_trunc('hour', logged_at) AS bucket_start,
    AVG(gaze_score)::DOUBLE PRECISION AS avg_gaze_score,
    AVG(blink_score)::DOUBLE PRECISION AS avg_blink_score,
    AVG(head_score)::DOUBLE PRECISION AS avg_head_score,
    AVG(focus_score)::DOUBLE PRECISION AS avg_focus_score,
    COUNT(*)::INT AS log_count,
    COUNT(*) FILTER (WHERE attention_state = 'FOCUSED')::INT AS focused_count,
    COUNT(*) FILTER (WHERE attention_state = 'NORMAL')::INT AS normal_count,
    COUNT(*) FILTER (WHERE attention_state = 'DISTRACTED')::INT AS distracted_count,
    COUNT(*) FILTER (WHERE face_detected = FALSE)::INT AS face_not_detected_count
  FROM concentration_logs
  WHERE logged_at < `);

const tierAggregate = (sourceTable, bucket) => Prisma.raw(`
  SELECT session_id, date_trunc('${bucket}', bucket_start) AS bucket_start,
    (SUM(avg_gaze_score * log_count) / SUM(log_count))::DOUBLE PRECISION AS avg_gaze_score,
    (SUM(avg_blink_score * log_count) / SUM(log_count))::DOUBLE PRECISION AS avg_blink_score,
    (SUM(avg_head_score * log_count) / SUM(log_count))::DOUBLE PRECISION AS avg_head_score,
    (SUM(avg_focus_score * log_count) / SUM(log_count))::DOUBLE PRECISION AS avg_focus_score,
    SUM(log_count)::INT AS log_count,
    SUM(focused_count)::INT AS focused_count,
    SUM(normal_count)::INT AS normal_count,
    SUM(distracted_count)::INT AS distracted_count,
    SUM(face_not_detected_count)::INT AS face_not_detected_count
  FROM ${sourceTable}
  WHERE bucket_start < `);

const STAGES = {
  hourly: {
    source: 'concentration_logs',
    target: 'hourly_stats',
    timeColumn: 'logged_at',
    aggregateStart: RAW_AGGREGATE,
    aggregateEnd: Prisma.raw(` GROUP BY session_id, date_trunc('hour', logged_at)`),
  },
  daily: {
    source: 'hourly_stats',
    target: 'daily_stats',
    timeColumn: 'bucket_start',
    aggregateStart: tierAggregate('hourly_stats', 'day'),
    aggregateEnd: Prisma.raw(` GROUP BY session_id, date_trunc('day', bucket_start)`),
  },
  weekly: {
    source: 'daily_stats',
    target: 'weekly_stats',
    timeColumn: 'bucket_start',
    aggregateStart: tierAggregate('daily_stats', 'week'),
    aggregateEnd: Prisma.raw(` GROUP BY session_id, date_trunc('week', bucket_start)`),
  },
};

const aggregateCte = (stage, cutoff) => Prisma.sql`
  WITH source_aggregate AS (
    ${stage.aggregateStart}${cutoff}${stage.aggregateEnd}
  )
`;

const rollupStage = async (stageName, cutoff, client = prisma) => {
  const stage = STAGES[stageName];
  if (!stage) throw new Error(`Unknown roll-up stage: ${stageName}`);

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLLUP_LOCK_ID})`;

    const [source] = await tx.$queryRaw(
      Prisma.sql`
        ${aggregateCte(stage, cutoff)}
        SELECT COALESCE(SUM(log_count), 0)::BIGINT AS log_count,
               COUNT(*)::BIGINT AS bucket_count,
               (
                 SELECT COUNT(*)::BIGINT
                 FROM ${Prisma.raw(stage.source)}
                 WHERE ${Prisma.raw(stage.timeColumn)} < ${cutoff}
               ) AS source_rows
        FROM source_aggregate
      `,
    );
    const sourceRows = Number(source.source_rows);
    const logCount = Number(source.log_count);
    const bucketCount = Number(source.bucket_count);
    if (bucketCount === 0) {
      return {
        stage: stageName, cutoff, source_rows: 0, log_count: 0, bucket_count: 0, deleted_rows: 0,
      };
    }

    await tx.$executeRaw(
      Prisma.sql`
        ${aggregateCte(stage, cutoff)}
        INSERT INTO ${Prisma.raw(stage.target)} (
          id, session_id, bucket_start,
          avg_gaze_score, avg_blink_score, avg_head_score, avg_focus_score,
          log_count, focused_count, normal_count, distracted_count,
          face_not_detected_count, created_at, updated_at
        )
        SELECT gen_random_uuid()::TEXT, session_id, bucket_start,
          avg_gaze_score, avg_blink_score, avg_head_score, avg_focus_score,
          log_count, focused_count, normal_count, distracted_count,
          face_not_detected_count, NOW(), NOW()
        FROM source_aggregate
        ON CONFLICT (session_id, bucket_start) DO UPDATE SET
          avg_gaze_score = EXCLUDED.avg_gaze_score,
          avg_blink_score = EXCLUDED.avg_blink_score,
          avg_head_score = EXCLUDED.avg_head_score,
          avg_focus_score = EXCLUDED.avg_focus_score,
          log_count = EXCLUDED.log_count,
          focused_count = EXCLUDED.focused_count,
          normal_count = EXCLUDED.normal_count,
          distracted_count = EXCLUDED.distracted_count,
          face_not_detected_count = EXCLUDED.face_not_detected_count,
          updated_at = NOW()
      `,
    );

    const [verification] = await tx.$queryRaw(
      Prisma.sql`
        ${aggregateCte(stage, cutoff)}
        SELECT COUNT(*)::BIGINT AS mismatch_count
        FROM source_aggregate source
        LEFT JOIN ${Prisma.raw(stage.target)} target
          ON target.session_id = source.session_id
         AND target.bucket_start = source.bucket_start
        WHERE target.id IS NULL
           OR target.log_count <> source.log_count
           OR target.focused_count <> source.focused_count
           OR target.normal_count <> source.normal_count
           OR target.distracted_count <> source.distracted_count
           OR target.face_not_detected_count <> source.face_not_detected_count
           OR ABS(target.avg_gaze_score - source.avg_gaze_score) > 0.000001
           OR ABS(target.avg_blink_score - source.avg_blink_score) > 0.000001
           OR ABS(target.avg_head_score - source.avg_head_score) > 0.000001
           OR ABS(target.avg_focus_score - source.avg_focus_score) > 0.000001
      `,
    );
    if (Number(verification.mismatch_count) !== 0) {
      throw new RollupVerificationError(`${stageName} roll-up verification failed`);
    }

    const deletedRows = await tx.$executeRaw(
      Prisma.sql`
        DELETE FROM ${Prisma.raw(stage.source)}
        WHERE ${Prisma.raw(stage.timeColumn)} < ${cutoff}
      `,
    );
    if (deletedRows !== sourceRows) {
      throw new RollupVerificationError(
        `${stageName} roll-up deleted ${deletedRows} rows; expected ${sourceRows}`,
      );
    }

    return {
      stage: stageName,
      cutoff,
      source_rows: sourceRows,
      log_count: logCount,
      bucket_count: bucketCount,
      deleted_rows: deletedRows,
    };
  }, { isolationLevel: 'Serializable', timeout: 60_000 });
};

const rollupConcentrationToHourly = (cutoff, client = prisma) =>
  rollupStage('hourly', cutoff, client);

const rollupHourlyToDaily = (cutoff, client = prisma) =>
  rollupStage('daily', cutoff, client);

const rollupDailyToWeekly = (cutoff, client = prisma) =>
  rollupStage('weekly', cutoff, client);

const readPositiveInteger = (value, fallback, name) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const getRetentionFromEnv = () => ({
  rawDays: readPositiveInteger(process.env.ROLLUP_RAW_RETENTION_DAYS, 30, 'ROLLUP_RAW_RETENTION_DAYS'),
  hourlyDays: readPositiveInteger(process.env.ROLLUP_HOURLY_RETENTION_DAYS, 90, 'ROLLUP_HOURLY_RETENTION_DAYS'),
  dailyDays: readPositiveInteger(process.env.ROLLUP_DAILY_RETENTION_DAYS, 365, 'ROLLUP_DAILY_RETENTION_DAYS'),
});

const runRollup = async ({ now = new Date(), client = prisma, retention = getRetentionFromEnv() } = {}) => {
  const cutoffs = getRollupCutoffs(now, retention);
  const hourly = await rollupConcentrationToHourly(cutoffs.hourly, client);
  const daily = await rollupHourlyToDaily(cutoffs.daily, client);
  const weekly = await rollupDailyToWeekly(cutoffs.weekly, client);
  return { started_at: now, cutoffs, stages: [hourly, daily, weekly] };
};

module.exports = {
  RollupVerificationError,
  floorUtcHour,
  floorUtcDay,
  floorUtcWeek,
  getRollupCutoffs,
  rollupConcentrationToHourly,
  rollupHourlyToDaily,
  rollupDailyToWeekly,
  runRollup,
};
