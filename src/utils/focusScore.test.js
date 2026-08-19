const {
  ATTENTION_THRESHOLDS,
  calcFocusScore,
  calcSessionAvgScore,
  getAttentionState,
  isValidScore,
} = require('../../backend/src/utils/focusScore');

describe('isValidScore', () => {
  it('accepts values in the 0~100 range', () => {
    expect(isValidScore(0)).toBe(true);
    expect(isValidScore(100)).toBe(true);
    expect(isValidScore(50.5)).toBe(true);
  });

  it('rejects non-number values', () => {
    expect(isValidScore('80')).toBe(false);
    expect(isValidScore(undefined)).toBe(false);
    expect(isValidScore(null)).toBe(false);
    expect(isValidScore(NaN)).toBe(false);
    expect(isValidScore(Infinity)).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(isValidScore(-0.1)).toBe(false);
    expect(isValidScore(100.1)).toBe(false);
  });
});

describe('calcFocusScore', () => {
  it('calculates weighted focus score: S = (gaze×0.4) + (blink×0.3) + (head×0.3)', () => {
    expect(calcFocusScore(100, 100, 100)).toBe(100);
    expect(calcFocusScore(0, 0, 0)).toBe(0);
    expect(calcFocusScore(100, 0, 0)).toBe(40);
    expect(calcFocusScore(0, 100, 0)).toBe(30);
    expect(calcFocusScore(0, 0, 100)).toBe(30);
  });

  it('rounds the result to two decimal places', () => {
    expect(calcFocusScore(85.55, 72.22, 90.11)).toBe(82.92);
  });
});

describe('getAttentionState', () => {
  it('returns FOCUSED when S >= 70', () => {
    expect(getAttentionState(ATTENTION_THRESHOLDS.FOCUSED)).toBe('FOCUSED');
    expect(getAttentionState(100)).toBe('FOCUSED');
  });

  it('returns NORMAL when 40 <= S < 70', () => {
    expect(getAttentionState(ATTENTION_THRESHOLDS.NORMAL)).toBe('NORMAL');
    expect(getAttentionState(69.999)).toBe('NORMAL');
  });

  it('returns DISTRACTED when S < 40', () => {
    expect(getAttentionState(39.999)).toBe('DISTRACTED');
    expect(getAttentionState(0)).toBe('DISTRACTED');
  });
});

describe('calcSessionAvgScore', () => {
  it('returns null when logs are absent', () => {
    expect(calcSessionAvgScore()).toBeNull();
    expect(calcSessionAvgScore([])).toBeNull();
  });

  it('calculates the average from concentration logs', () => {
    expect(calcSessionAvgScore([{ focus_score: 80 }, { focus_score: 60 }])).toBe(70);
  });

  it('rounds the average to two decimal places', () => {
    expect(calcSessionAvgScore([{ focus_score: 80.123 }, { focus_score: 70.456 }])).toBe(75.29);
  });
});
