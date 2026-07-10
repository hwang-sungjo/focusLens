const ATTENTION_STATE = Object.freeze({
  FOCUSED: 'FOCUSED',
  NORMAL: 'NORMAL',
  DISTRACTED: 'DISTRACTED',
});

const SCORE_MIN = 0;
const SCORE_MAX = 100;

const WEIGHTS = Object.freeze({
  gaze: 0.4,
  blink: 0.3,
  head: 0.3,
});

class FocusScoreValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FocusScoreValidationError';
  }
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function validateScore(value, fieldName) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new FocusScoreValidationError(`${fieldName} must be a valid number`);
  }

  if (value < SCORE_MIN || value > SCORE_MAX) {
    throw new FocusScoreValidationError(
      `${fieldName} must be between ${SCORE_MIN} and ${SCORE_MAX}`,
    );
  }

  return value;
}

/**
 * S = (gaze × 0.4) + (blink × 0.3) + (head × 0.3)
 *
 * @param {number} gaze
 * @param {number} blink
 * @param {number} head
 * @returns {number}
 */
function calculateFocusScore(gaze, blink, head) {
  const validGaze = validateScore(gaze, 'gaze');
  const validBlink = validateScore(blink, 'blink');
  const validHead = validateScore(head, 'head');

  return (
    validGaze * WEIGHTS.gaze +
    validBlink * WEIGHTS.blink +
    validHead * WEIGHTS.head
  );
}

/**
 * @param {number} score
 * @returns {'FOCUSED' | 'NORMAL' | 'DISTRACTED'}
 */
function getAttentionState(score) {
  const validScore = validateScore(score, 'score');

  if (validScore >= 70) {
    return ATTENTION_STATE.FOCUSED;
  }

  if (validScore >= 40) {
    return ATTENTION_STATE.NORMAL;
  }

  return ATTENTION_STATE.DISTRACTED;
}

module.exports = {
  ATTENTION_STATE,
  SCORE_MIN,
  SCORE_MAX,
  WEIGHTS,
  FocusScoreValidationError,
  validateScore,
  calculateFocusScore,
  getAttentionState,
};
