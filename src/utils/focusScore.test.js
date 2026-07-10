const {
  ATTENTION_STATE,
  FocusScoreValidationError,
  calculateFocusScore,
  getAttentionState,
  validateScore,
} = require('./focusScore');

describe('validateScore', () => {
  it('accepts values in the 0~100 range', () => {
    expect(validateScore(0, 'gaze')).toBe(0);
    expect(validateScore(100, 'gaze')).toBe(100);
    expect(validateScore(50.5, 'gaze')).toBe(50.5);
  });

  it('rejects non-number values', () => {
    expect(() => validateScore('80', 'gaze')).toThrow(FocusScoreValidationError);
    expect(() => validateScore(undefined, 'gaze')).toThrow(FocusScoreValidationError);
    expect(() => validateScore(null, 'gaze')).toThrow(FocusScoreValidationError);
    expect(() => validateScore(NaN, 'gaze')).toThrow(FocusScoreValidationError);
  });

  it('rejects out-of-range values', () => {
    expect(() => validateScore(-0.1, 'gaze')).toThrow(FocusScoreValidationError);
    expect(() => validateScore(100.1, 'gaze')).toThrow(FocusScoreValidationError);
  });
});

describe('calculateFocusScore', () => {
  it('calculates weighted focus score: S = (gaze×0.4) + (blink×0.3) + (head×0.3)', () => {
    expect(calculateFocusScore(100, 100, 100)).toBe(100);
    expect(calculateFocusScore(0, 0, 0)).toBe(0);
    expect(calculateFocusScore(100, 0, 0)).toBe(40);
    expect(calculateFocusScore(0, 100, 0)).toBe(30);
    expect(calculateFocusScore(0, 0, 100)).toBe(30);
    expect(calculateFocusScore(85.5, 72, 90)).toBeCloseTo(82.8, 5);
  });

  it('validates all input scores', () => {
    expect(() => calculateFocusScore(101, 50, 50)).toThrow(FocusScoreValidationError);
    expect(() => calculateFocusScore(50, -1, 50)).toThrow(FocusScoreValidationError);
    expect(() => calculateFocusScore(50, 50, NaN)).toThrow(FocusScoreValidationError);
  });
});

describe('getAttentionState', () => {
  it('returns FOCUSED when S >= 70', () => {
    expect(getAttentionState(70)).toBe(ATTENTION_STATE.FOCUSED);
    expect(getAttentionState(100)).toBe(ATTENTION_STATE.FOCUSED);
    expect(getAttentionState(85.5)).toBe(ATTENTION_STATE.FOCUSED);
  });

  it('returns NORMAL when 40 <= S < 70', () => {
    expect(getAttentionState(40)).toBe(ATTENTION_STATE.NORMAL);
    expect(getAttentionState(69.999)).toBe(ATTENTION_STATE.NORMAL);
    expect(getAttentionState(55)).toBe(ATTENTION_STATE.NORMAL);
  });

  it('returns DISTRACTED when S < 40', () => {
    expect(getAttentionState(39.999)).toBe(ATTENTION_STATE.DISTRACTED);
    expect(getAttentionState(0)).toBe(ATTENTION_STATE.DISTRACTED);
    expect(getAttentionState(20)).toBe(ATTENTION_STATE.DISTRACTED);
  });

  it('validates score input', () => {
    expect(() => getAttentionState(101)).toThrow(FocusScoreValidationError);
    expect(() => getAttentionState(-1)).toThrow(FocusScoreValidationError);
  });
});

describe('calculateFocusScore + getAttentionState integration', () => {
  it('maps high composite score to FOCUSED', () => {
    const score = calculateFocusScore(90, 80, 85);
    expect(score).toBeCloseTo(85.5, 5);
    expect(getAttentionState(score)).toBe(ATTENTION_STATE.FOCUSED);
  });

  it('maps low composite score to DISTRACTED', () => {
    const score = calculateFocusScore(30, 20, 25);
    expect(score).toBeCloseTo(25.5, 5);
    expect(getAttentionState(score)).toBe(ATTENTION_STATE.DISTRACTED);
  });
});
