// src/routes/rankings.js
const { Router } = require('express');
const { query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const rankingsController = require('../controllers/rankingsController');

const router = Router();

router.use(authenticate);

// GET /api/rankings
// ?scope=global|friends|group  &period=daily|weekly  &metric=focus_score|study_time
router.get(
  '/',
  [
    query('scope')
      .optional()
      .isIn(['global', 'friends', 'group'])
      .withMessage('scope는 global / friends / group 중 하나여야 합니다.'),
    query('period')
      .optional()
      .isIn(['daily', 'weekly'])
      .withMessage('period는 daily / weekly 중 하나여야 합니다.'),
    query('metric')
      .optional()
      .isIn(['focus_score', 'study_time'])
      .withMessage('metric은 focus_score / study_time 중 하나여야 합니다.'),
  ],
  validate,
  rankingsController.getRankings,
);

module.exports = router;
