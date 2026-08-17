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
      .exists({ checkFalsy: true })
      .withMessage('scope는 필수입니다.')
      .bail()
      .isIn(['global', 'friends', 'group'])
      .withMessage('scope는 global / friends / group 중 하나여야 합니다.'),
    query('period')
      .exists({ checkFalsy: true })
      .withMessage('period는 필수입니다.')
      .bail()
      .isIn(['daily', 'weekly'])
      .withMessage('period는 daily / weekly 중 하나여야 합니다.'),
    query('metric')
      .exists({ checkFalsy: true })
      .withMessage('metric은 필수입니다.')
      .bail()
      .isIn(['focus_score', 'study_time'])
      .withMessage('metric은 focus_score / study_time 중 하나여야 합니다.'),
    query('group_id')
      .if(query('scope').equals('group'))
      .isUUID()
      .withMessage('scope=group일 때 유효한 group_id는 필수입니다.'),
  ],
  validate,
  rankingsController.getRankings,
);

module.exports = router;
