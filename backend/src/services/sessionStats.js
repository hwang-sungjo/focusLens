const { Prisma } = require('@prisma/client');
const prisma = require('../models/prismaClient');

const toNumberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

const normalizeMetric = (row) => ({
  session_id: row.session_id,
  gaze_score_sum: Number(row.gaze_score_sum),
  blink_score_sum: Number(row.blink_score_sum),
  head_score_sum: Number(row.head_score_sum),
  focus_score_sum: Number(row.focus_score_sum),
  log_count: Number(row.log_count),
  focused_count: Number(row.focused_count),
  normal_count: Number(row.normal_count),
  distracted_count: Number(row.distracted_count),
  face_not_detected_count: Number(row.face_not_detected_count),
  avg_gaze_score: toNumberOrNull(row.avg_gaze_score),
  avg_blink_score: toNumberOrNull(row.avg_blink_score),
  avg_head_score: toNumberOrNull(row.avg_head_score),
  avg_focus_score: toNumberOrNull(row.avg_focus_score),
});

const getSessionMetricMap = async (sessionIds, client = prisma) => {
  if (!sessionIds.length) return new Map();
  const rows = await client.$queryRaw(
    Prisma.sql`
      SELECT *
      FROM v_session_metric_totals
      WHERE session_id IN (${Prisma.join(sessionIds)})
    `,
  );
  return new Map(rows.map((row) => [row.session_id, normalizeMetric(row)]));
};

const getSessionTimeline = async (sessionId, client = prisma) => {
  const rows = await client.$queryRaw(
    Prisma.sql`
      SELECT
        'MINUTE'::TEXT AS granularity,
        minute_index,
        logged_at,
        gaze_score,
        blink_score,
        head_score,
        focus_score,
        attention_state::TEXT AS attention_state,
        face_detected,
        1::INT AS log_count,
        (attention_state = 'FOCUSED')::INT AS focused_count,
        (attention_state = 'NORMAL')::INT AS normal_count,
        (attention_state = 'DISTRACTED')::INT AS distracted_count,
        (NOT face_detected)::INT AS face_not_detected_count
      FROM concentration_logs
      WHERE session_id = ${sessionId}

      UNION ALL

      SELECT 'HOUR'::TEXT, NULL::INT, bucket_start,
        avg_gaze_score, avg_blink_score, avg_head_score, avg_focus_score,
        NULL::TEXT, NULL::BOOLEAN, log_count,
        focused_count, normal_count, distracted_count, face_not_detected_count
      FROM hourly_stats WHERE session_id = ${sessionId}

      UNION ALL

      SELECT 'DAY'::TEXT, NULL::INT, bucket_start,
        avg_gaze_score, avg_blink_score, avg_head_score, avg_focus_score,
        NULL::TEXT, NULL::BOOLEAN, log_count,
        focused_count, normal_count, distracted_count, face_not_detected_count
      FROM daily_stats WHERE session_id = ${sessionId}

      UNION ALL

      SELECT 'WEEK'::TEXT, NULL::INT, bucket_start,
        avg_gaze_score, avg_blink_score, avg_head_score, avg_focus_score,
        NULL::TEXT, NULL::BOOLEAN, log_count,
        focused_count, normal_count, distracted_count, face_not_detected_count
      FROM weekly_stats WHERE session_id = ${sessionId}

      ORDER BY logged_at ASC, granularity ASC
    `,
  );

  return rows.map((row) => ({
    granularity: row.granularity,
    minute_index: row.minute_index,
    logged_at: row.logged_at,
    gaze_score: Number(row.gaze_score),
    blink_score: Number(row.blink_score),
    head_score: Number(row.head_score),
    focus_score: Number(row.focus_score),
    attention_state: row.attention_state,
    face_detected: row.face_detected,
    log_count: Number(row.log_count),
    focused_count: Number(row.focused_count),
    normal_count: Number(row.normal_count),
    distracted_count: Number(row.distracted_count),
    face_not_detected_count: Number(row.face_not_detected_count),
  }));
};

module.exports = { getSessionMetricMap, getSessionTimeline };
