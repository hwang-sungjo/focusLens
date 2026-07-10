// src/routes/groups.js
const { Router } = require('express');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const groupsController = require('../controllers/groupsController');

const router = Router();

router.use(authenticate);

// POST /api/groups  — 그룹 생성 (생성자는 OWNER로 자동 등록)
router.post(
  '/',
  [
    body('name').notEmpty().isString().isLength({ max: 100 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('group_type').isIn(['STUDY', 'PROJECT', 'CHALLENGE']),
    body('visibility').isIn(['PUBLIC', 'PRIVATE']),
  ],
  validate,
  groupsController.createGroup,
);

// GET /api/groups  — 내가 속한 그룹 목록
router.get('/', groupsController.getMyGroups);

// POST /api/groups/join  — 초대 코드로 그룹 참여 (/:id보다 먼저 등록)
router.post(
  '/join',
  [body('invite_code').notEmpty().withMessage('초대 코드가 필요합니다.')],
  validate,
  groupsController.joinGroup,
);

// GET /api/groups/:id  — 그룹 상세 조회
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  groupsController.getGroup,
);

// POST /api/groups/:id/invite  — 그룹 초대 (OWNER/MANAGER만)
router.post(
  '/:id/invite',
  [
    param('id').isUUID(),
    body('invitee_email').optional().isEmail(),
    body('invitee_user_id').optional().isUUID(),
  ],
  validate,
  groupsController.inviteMember,
);

// PATCH /api/groups/:id/members/:memberId  — 멤버 권한 변경 (OWNER만)
router.patch(
  '/:id/members/:memberId',
  [
    param('id').isUUID(),
    param('memberId').isUUID(),
    body('group_role').isIn(['MANAGER', 'MEMBER']).withMessage('group_role은 MANAGER 또는 MEMBER여야 합니다.'),
  ],
  validate,
  groupsController.updateMemberRole,
);

// DELETE /api/groups/:id/members/:memberId  — 멤버 내보내기 (OWNER/MANAGER만)
router.delete(
  '/:id/members/:memberId',
  [param('id').isUUID(), param('memberId').isUUID()],
  validate,
  groupsController.removeMember,
);

// GET /api/groups/:id/dashboard  — 그룹 대시보드 (v_group_member_stats 뷰)
router.get('/:id/dashboard', [param('id').isUUID()], validate, groupsController.getDashboard);

// POST /api/groups/:id/goals  — 목표 생성 (OWNER/MANAGER만)
router.post(
  '/:id/goals',
  [
    param('id').isUUID(),
    body('title').notEmpty().isString().isLength({ max: 200 }),
    body('target_study_minutes').optional().isInt({ min: 1 }),
    body('target_focus_score').optional().isFloat({ min: 0, max: 100 }),
    body('start_date').isISO8601(),
    body('end_date').isISO8601(),
  ],
  validate,
  groupsController.createGoal,
);

// GET /api/groups/:id/goals  — 목표 목록 조회
router.get('/:id/goals', [param('id').isUUID()], validate, groupsController.getGoals);

// POST /api/groups/:id/goals/:goalId/assignees  — 목표 배정
router.post(
  '/:id/goals/:goalId/assignees',
  [
    param('id').isUUID(),
    param('goalId').isUUID(),
    body('group_member_ids').isArray({ min: 1 }).withMessage('배정할 멤버 ID 목록이 필요합니다.'),
    body('group_member_ids.*').isUUID(),
  ],
  validate,
  groupsController.assignGoal,
);

// POST /api/groups/:id/feedbacks  — 관리자 피드백 작성
router.post(
  '/:id/feedbacks',
  [
    param('id').isUUID(),
    body('target_member_id').isUUID(),
    body('content').notEmpty().isString().isLength({ max: 2000 }),
    body('session_id').optional().isUUID(),
  ],
  validate,
  groupsController.createFeedback,
);

// GET /api/groups/:id/feedbacks  — 피드백 조회 (OWNER/MANAGER: 전체 / MEMBER: 본인만)
router.get('/:id/feedbacks', [param('id').isUUID()], validate, groupsController.getFeedbacks);

module.exports = router;
