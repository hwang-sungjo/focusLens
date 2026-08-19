const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const groupsController = require('../controllers/groupsController');

const router = Router();
const uuidParam = (name) => param(name).isUUID().withMessage(`${name}는 유효한 UUID여야 합니다.`);
const nullableString = (field, max) =>
  body(field).optional({ values: 'null' }).isString().isLength({ max });

router.use(authenticate);

router.post(
  '/',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 100 }).withMessage('name은 필수입니다.'),
    nullableString('description', 500),
    body('group_type').optional().isIn(['STUDY', 'PROJECT', 'CHALLENGE']),
    body('visibility').optional().isIn(['PUBLIC', 'PRIVATE']),
  ],
  validate,
  groupsController.createGroup,
);

router.get('/', groupsController.getMyGroups);

router.post(
  '/join',
  [body('invite_code').isString().trim().notEmpty().withMessage('초대 코드가 필요합니다.')],
  validate,
  groupsController.joinGroup,
);

router.get('/:id', [uuidParam('id')], validate, groupsController.getGroup);

router.post(
  '/:id/invite',
  [
    uuidParam('id'),
    body('invitee_email').optional({ values: 'null' }).isEmail(),
    body('invitee_user_id').optional({ values: 'null' }).isUUID(),
    body('expires_in_days').optional().isInt({ min: 1, max: 30 }),
  ],
  validate,
  groupsController.inviteMember,
);

router.patch(
  '/:id/members/:memberId',
  [
    uuidParam('id'),
    uuidParam('memberId'),
    body('group_role')
      .isIn(['OWNER', 'MANAGER', 'MEMBER'])
      .withMessage('group_role은 OWNER, MANAGER, MEMBER 중 하나여야 합니다.'),
  ],
  validate,
  groupsController.updateMemberRole,
);

router.delete(
  '/:id/members/:memberId',
  [uuidParam('id'), uuidParam('memberId')],
  validate,
  groupsController.removeMember,
);

router.get('/:id/dashboard', [uuidParam('id')], validate, groupsController.getDashboard);

router.post(
  '/:id/goals',
  [
    uuidParam('id'),
    body('title').isString().trim().notEmpty().isLength({ max: 200 }),
    nullableString('description', 1000),
    body('target_study_minutes')
      .optional({ values: 'null' })
      .custom((value) => Number.isInteger(value) && value > 0)
      .withMessage('target_study_minutes는 1 이상의 정수여야 합니다.'),
    body('target_focus_score')
      .optional({ values: 'null' })
      .custom((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
      .withMessage('target_focus_score는 0~100 범위의 숫자여야 합니다.'),
    body('start_date')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .bail()
      .isISO8601({ strict: true })
      .withMessage('start_date는 YYYY-MM-DD 형식이어야 합니다.'),
    body('end_date')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .bail()
      .isISO8601({ strict: true })
      .withMessage('end_date는 YYYY-MM-DD 형식이어야 합니다.'),
  ],
  validate,
  groupsController.createGoal,
);

router.get(
  '/:id/goals',
  [
    uuidParam('id'),
    query('status').optional().isIn(['ACTIVE', 'COMPLETED', 'CANCELLED']),
  ],
  validate,
  groupsController.getGoals,
);

router.post(
  '/:id/goals/:goalId/assignees',
  [
    uuidParam('id'),
    uuidParam('goalId'),
    body('group_member_ids').optional().isArray(),
    body('group_member_ids.*').isUUID().withMessage('group_member_ids는 UUID 배열이어야 합니다.'),
  ],
  validate,
  groupsController.assignGoal,
);

router.post(
  '/:id/feedbacks',
  [
    uuidParam('id'),
    body('target_member_id').isUUID(),
    body('content').isString().trim().notEmpty().isLength({ max: 2000 }),
    body('session_id').optional({ values: 'null' }).isUUID(),
  ],
  validate,
  groupsController.createFeedback,
);

router.get(
  '/:id/feedbacks',
  [
    uuidParam('id'),
    query('target_member_id').optional().isUUID(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  groupsController.getFeedbacks,
);

module.exports = router;
