const {
  calculateAverage,
  calculateDurationSeconds,
  buildSessionSummary,
} = require('../../backend/src/utils/sessionMetrics');

describe('session metrics', () => {
  it('returns null averages and zero counts for an empty completed session', () => {
    const startedAt = new Date('2026-10-02T00:00:00.000Z');
    const endedAt = new Date('2026-10-02T00:10:00.999Z');

    expect(buildSessionSummary([], startedAt, endedAt)).toEqual({
      avg_focus_score: null,
      duration_seconds: 600,
      gaze_avg: null,
      blink_avg: null,
      head_avg: null,
      focused_minutes: 0,
      normal_minutes: 0,
      distracted_minutes: 0,
      total_logs: 0,
    });
  });

  it('includes a face-undetected zero log in averages and state counts', () => {
    const logs = [{
      gaze_score: 0,
      blink_score: 0,
      head_score: 0,
      focus_score: 0,
      attention_state: 'DISTRACTED',
      face_detected: false,
    }];

    expect(buildSessionSummary(
      logs,
      new Date('2026-10-02T00:00:00.000Z'),
      new Date('2026-10-02T00:01:00.000Z'),
    )).toEqual({
      avg_focus_score: 0,
      duration_seconds: 60,
      gaze_avg: 0,
      blink_avg: 0,
      head_avg: 0,
      focused_minutes: 0,
      normal_minutes: 0,
      distracted_minutes: 1,
      total_logs: 1,
    });
  });

  it('uses a log-weighted two-decimal average for multiple logs', () => {
    expect(calculateAverage([
      { focus_score: 0 },
      { focus_score: 50 },
      { focus_score: 100 },
    ])).toBe(50);
    expect(calculateAverage([{ focus_score: 33.33 }, { focus_score: 66.66 }])).toBe(50);
  });

  it('returns null duration for an active session and clamps negative durations', () => {
    const startedAt = new Date('2026-10-02T00:01:00.000Z');
    expect(calculateDurationSeconds(startedAt, null)).toBeNull();
    expect(calculateDurationSeconds(startedAt, new Date('2026-10-02T00:00:00.000Z'))).toBe(0);
  });
});
