// src/controllers/groupsController.js
// 보안 원칙: 그룹 권한은 반드시 group_members.group_role 기준으로 판단
//           groups.created_by_user_id 단독 판단 금지
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');
const { randomBytes } = require('crypto');

// --- 헬퍼: 현재 사용자의 그룹 멤버 정보 조회 ---
const getMyMember = async (groupId, userId) => {
  return prisma.group_members.findFirst({
    where: { group_id: groupId, user_id: userId, status: 'ACTIVE' },
  });
};

const hasRole = (member, ...roles) => member && roles.includes(member.group_role);

/** POST /api/groups */
const createGroup = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { name, description, group_type, visibility } = req.body;

    const group = await prisma.groups.create({
      data: {
        created_by_user_id: userId,
        name,
        description,
        group_type,
        visibility,
        status: 'ACTIVE',
        // 생성자를 group_members에 OWNER로 자동 등록
        group_members: {
          create: { user_id: userId, group_role: 'OWNER', status: 'ACTIVE', joined_at: new Date() },
        },
      },
      select: { id: true, name: true, group_type: true, visibility: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { group }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups */
const getMyGroups = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const memberships = await prisma.group_members.findMany({
      where: { user_id: userId, status: 'ACTIVE' },
      include: { groups: { select: { id: true, name: true, group_type: true, visibility: true } } },
    });
    const groups = memberships.map((m) => ({ ...m.groups, role: m.group_role }));
    return res.status(200).json({ success: true, data: { groups }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/join */
const joinGroup = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { invite_code } = req.body;

    const invitation = await prisma.group_invitations.findUnique({ where: { invite_code } });
    if (!invitation) return next(createError('유효하지 않은 초대 코드입니다.', 404));
    if (invitation.status !== 'PENDING' || invitation.expires_at < new Date()) {
      return next(createError('만료되었거나 이미 사용된 초대 코드입니다.', 400));
    }

    const [, member] = await prisma.$transaction([
      prisma.group_invitations.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', invitee_user_id: userId },
      }),
      prisma.group_members.create({
        data: {
          group_id: invitation.group_id,
          user_id: userId,
          group_role: 'MEMBER',
          status: 'ACTIVE',
          joined_at: new Date(),
        },
        select: { id: true, group_role: true, joined_at: true },
      }),
    ]);

    return res.status(201).json({ success: true, data: { member }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id */
const getGroup = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id } = req.params;

    const group = await prisma.groups.findUnique({
      where: { id },
      include: { group_members: { where: { status: 'ACTIVE' }, select: { group_role: true, user_id: true } } },
    });
    if (!group || group.deleted_at) return next(createError('그룹을 찾을 수 없습니다.', 404));

    // PRIVATE 그룹은 멤버만 조회 가능
    if (group.visibility === 'PRIVATE') {
      const isMember = group.group_members.some((m) => m.user_id === userId);
      if (!isMember) return next(createError('비공개 그룹에 접근 권한이 없습니다.', 403));
    }

    return res.status(200).json({ success: true, data: { group }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/invite */
const inviteMember = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;
    const { invitee_email, invitee_user_id } = req.body;

    // 그룹 권한: group_members.group_role 기준 (OWNER / MANAGER만 가능)
    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER', 'MANAGER')) {
      return next(createError('초대 권한이 없습니다. OWNER 또는 MANAGER만 가능합니다.', 403));
    }

    const invite_code = randomBytes(16).toString('hex');
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7일

    const invitation = await prisma.group_invitations.create({
      data: {
        group_id: groupId,
        inviter_member_id: myMember.id,
        invitee_email,
        invitee_user_id,
        invite_code,
        status: 'PENDING',
        expires_at,
      },
      select: { id: true, invite_code: true, expires_at: true },
    });

    return res.status(201).json({ success: true, data: { invitation }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/groups/:id/members/:memberId */
const updateMemberRole = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId, memberId } = req.params;
    const { group_role } = req.body;

    // OWNER만 권한 변경 가능
    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER')) return next(createError('OWNER만 권한을 변경할 수 있습니다.', 403));

    const updated = await prisma.group_members.update({
      where: { id: memberId },
      data: { group_role },
      select: { id: true, user_id: true, group_role: true },
    });

    return res.status(200).json({ success: true, data: { member: updated }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/groups/:id/members/:memberId */
const removeMember = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId, memberId } = req.params;

    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER', 'MANAGER')) return next(createError('내보내기 권한이 없습니다.', 403));

    const target = await prisma.group_members.findUnique({ where: { id: memberId } });
    if (!target) return next(createError('멤버를 찾을 수 없습니다.', 404));
    // OWNER 본인 내보내기 불가
    if (target.user_id === userId) return next(createError('본인을 내보낼 수 없습니다.', 400));

    await prisma.group_members.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
    return res.status(200).json({ success: true, data: {}, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/dashboard */
const getDashboard = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;

    const myMember = await getMyMember(groupId, userId);
    if (!myMember) return next(createError('그룹 멤버가 아닙니다.', 403));

    // OWNER/MANAGER: 전체 구성원 데이터 / MEMBER: 자신 데이터만
    // TODO: v_group_member_stats View 쿼리로 교체
    const isManager = hasRole(myMember, 'OWNER', 'MANAGER');
    const stats = { group_id: groupId, scope: isManager ? 'all_members' : 'self', data: [] };

    return res.status(200).json({ success: true, data: { dashboard: stats }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/goals */
const createGoal = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;
    const { title, description, target_study_minutes, target_focus_score, start_date, end_date } = req.body;

    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER', 'MANAGER')) return next(createError('목표 생성 권한이 없습니다.', 403));

    const goal = await prisma.group_goals.create({
      data: {
        group_id: groupId,
        created_by_member_id: myMember.id,
        title,
        description,
        target_study_minutes,
        target_focus_score,
        start_date: new Date(start_date),
        end_date: new Date(end_date),
        status: 'ACTIVE',
      },
      select: { id: true, title: true, start_date: true, end_date: true, status: true },
    });

    return res.status(201).json({ success: true, data: { goal }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/goals */
const getGoals = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;

    const myMember = await getMyMember(groupId, userId);
    if (!myMember) return next(createError('그룹 멤버가 아닙니다.', 403));

    const goals = await prisma.group_goals.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'desc' },
    });

    return res.status(200).json({ success: true, data: { goals }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/goals/:goalId/assignees */
const assignGoal = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId, goalId } = req.params;
    const { group_member_ids } = req.body;

    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER', 'MANAGER')) return next(createError('목표 배정 권한이 없습니다.', 403));

    await prisma.group_goal_assignees.createMany({
      data: group_member_ids.map((gmId) => ({ group_goal_id: goalId, group_member_id: gmId })),
      skipDuplicates: true,
    });

    return res.status(201).json({ success: true, data: {}, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/feedbacks */
const createFeedback = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;
    const { target_member_id, content, session_id } = req.body;

    // manager_member_id: JWT sub 기준 group_members 조회 (OWNER/MANAGER만 피드백 작성)
    const myMember = await getMyMember(groupId, userId);
    if (!hasRole(myMember, 'OWNER', 'MANAGER')) return next(createError('피드백 작성 권한이 없습니다.', 403));

    const feedback = await prisma.manager_feedbacks.create({
      data: {
        group_id: groupId,
        manager_member_id: myMember.id,
        target_member_id,
        session_id: session_id || null,
        content,
      },
      select: { id: true, content: true, created_at: true },
    });

    return res.status(201).json({ success: true, data: { feedback }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/feedbacks */
const getFeedbacks = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id: groupId } = req.params;

    const myMember = await getMyMember(groupId, userId);
    if (!myMember) return next(createError('그룹 멤버가 아닙니다.', 403));

    // OWNER/MANAGER: 전체 / MEMBER: 자신이 받은 피드백만
    const where = {
      group_id: groupId,
      ...(hasRole(myMember, 'OWNER', 'MANAGER') ? {} : { target_member_id: myMember.id }),
    };

    const feedbacks = await prisma.manager_feedbacks.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: { id: true, content: true, session_id: true, target_member_id: true, created_at: true },
    });

    return res.status(200).json({ success: true, data: { feedbacks }, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createGroup, getMyGroups, joinGroup, getGroup,
  inviteMember, updateMemberRole, removeMember,
  getDashboard, createGoal, getGoals, assignGoal,
  createFeedback, getFeedbacks,
};
