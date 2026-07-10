// src/utils/focusScore.js
// 집중도 점수 산정 알고리즘 — docs/backend-plan.md §참고: 집중도 점수 산정 알고리즘
// S = (Gaze × 0.4) + (Blink × 0.3) + (Head × 0.3)

const WEIGHTS = {
  gaze: 0.4,
  blink: 0.3,
  head: 0.3,
};

const ATTENTION_THRESHOLDS = {
  FOCUSED: 70,   // S >= 70  → 집중 상태
  NORMAL: 40,    // 40 <= S < 70 → 보통
  // S < 40 → 집중 이탈 경고
};

/**
 * 분 단위 집중도 점수 계산
 * @param {number} gazeScore   - 0~100 float
 * @param {number} blinkScore  - 0~100 float
 * @param {number} headScore   - 0~100 float
 * @returns {number} focusScore - 0~100 float (소수점 2자리)
 */
const calcFocusScore = (gazeScore, blinkScore, headScore) => {
  const score =
    gazeScore * WEIGHTS.gaze +
    blinkScore * WEIGHTS.blink +
    headScore * WEIGHTS.head;
  return Math.round(score * 100) / 100;
};

/**
 * 집중도 점수 → 주의 집중 상태 문자열 변환
 * concentration_logs.attention_state 컬럼에 저장되는 값
 * @param {number} focusScore
 * @returns {'FOCUSED'|'NORMAL'|'DISTRACTED'}
 */
const getAttentionState = (focusScore) => {
  if (focusScore >= ATTENTION_THRESHOLDS.FOCUSED) return 'FOCUSED';
  if (focusScore >= ATTENTION_THRESHOLDS.NORMAL) return 'NORMAL';
  return 'DISTRACTED';
};

/**
 * concentration_logs 배열에서 세션 평균 집중도 계산
 * sessions 테이블에 avg_focus_score를 저장하지 않으므로, 리포트/조회 시 항상 이 함수로 계산
 * @param {Array<{focus_score: number}>} logs
 * @returns {number|null} 평균 집중도 (로그 없으면 null)
 */
const calcSessionAvgScore = (logs) => {
  if (!logs || logs.length === 0) return null;
  const sum = logs.reduce((acc, log) => acc + (log.focus_score ?? 0), 0);
  return Math.round((sum / logs.length) * 100) / 100;
};

/**
 * 0~100 범위 float 유효성 검사 — 보안 정책 ① 점수 범위 검증
 * @param {number} value
 * @returns {boolean}
 */
const isValidScore = (value) =>
  typeof value === 'number' && isFinite(value) && value >= 0 && value <= 100;

module.exports = {
  calcFocusScore,
  getAttentionState,
  calcSessionAvgScore,
  isValidScore,
  WEIGHTS,
  ATTENTION_THRESHOLDS,
};
