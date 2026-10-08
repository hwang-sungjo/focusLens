const roundToTwo = (value) => Math.round(value * 100) / 100;

const calculateAverage = (logs, field = 'focus_score') => {
  if (!logs?.length) return null;
  return roundToTwo(logs.reduce((sum, log) => sum + log[field], 0) / logs.length);
};

const calculateDurationSeconds = (startedAt, endedAt) => {
  if (!endedAt) return null;
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
};

const buildSessionSummary = (logs, startedAt, endedAt) => ({
  avg_focus_score: calculateAverage(logs),
  duration_seconds: calculateDurationSeconds(startedAt, endedAt),
  gaze_avg: calculateAverage(logs, 'gaze_score'),
  blink_avg: calculateAverage(logs, 'blink_score'),
  head_avg: calculateAverage(logs, 'head_score'),
  focused_minutes: logs.filter((log) => log.attention_state === 'FOCUSED').length,
  normal_minutes: logs.filter((log) => log.attention_state === 'NORMAL').length,
  distracted_minutes: logs.filter((log) => log.attention_state === 'DISTRACTED').length,
  total_logs: logs.length,
});

module.exports = {
  roundToTwo,
  calculateAverage,
  calculateDurationSeconds,
  buildSessionSummary,
};
