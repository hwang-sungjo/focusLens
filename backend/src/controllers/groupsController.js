// 보안 원칙: 그룹 권한은 반드시 group_members.group_role 기준으로 판단
// groups.created_by_user_id는 생성 이력 보존용이며 권한 판단에 사용하지 않는다.
const { Prisma } = require('@prisma/client');
const { randomBytes } = require('crypto');
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

const MANAGER_ROLES = ['OWNER', 'MANAGER'];

const getActiveGroup = (groupId) =>
  prisma.groups.findFirst({
    where: { id: groupId, status: 'ACTIVE', deleted_at: null },
  });

const getMyMember = (groupId, userId) =>
  prisma.group_members.findUnique({
    where: { group_id_user_id: { group_id: groupId, user_id: userId } },
  });

const isActiveMember = (member) => member?.status === 'ACTIVE';
const hasRole = (member, ...roles) => isActiveMember(member) && roles.includes(member.group_role);
const dateOnly = (date) => date.toISOString().slice(0, 10);
const parseDateOnly = (value) => new Date(`${value}T00:00:00.000Z`);

const requireGroup = async (groupId) => {
  const group = await getActiveGroup(groupId);
  if (!group) throw createError('그룹을 찾을 수 없습니다.', 404);
  return group;
};

/** POST /api/groups */
const createGroup = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { name, description = null, group_type = 'STUDY', visibility = 'PRIVATE' } = req.body;

    const group = await prisma.groups.create({
      data: {
        created_by_user_id: userId,
        name,
        description,
        group_type,
        visibility,
        status: 'ACTIVE',
        group_members: {
          create: { user_id: userId, group_role: 'OWNER', status: 'ACTIVE', joined_at: new Date() },
        },
      },
      select: {
        id: true,
        name: true,
        description: true,
        group_type: true,
        visibility: true,
        status: true,
        created_at: true,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        group_id: group.id,
        name: group.name,
        description: group.description,
        group_type: group.group_type,
        visibility: group.visibility,
        status: group.status,
        my_role: 'OWNER',
        created_at: group.created_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups */
const getMyGroups = async (req, res, next) => {
  try {
    const memberships = await prisma.group_members.findMany({
      where: {
        user_id: req.user.sub,
        status: 'ACTIVE',
        group: { status: 'ACTIVE', deleted_at: null },
      },
      orderBy: { joined_at: 'desc' },
      include: {
        group: {
          select: {
            id: true,
            name: true,
            description: true,
            group_type: true,
            visibility: true,
            status: true,
            created_at: true,
            _count: { select: { group_members: { where: { status: 'ACTIVE' } } } },
          },
        },
      },
    });

    const groups = memberships.map(({ group, group_role: myRole, joined_at: joinedAt }) => ({
      group_id: group.id,
      name: group.name,
      description: group.description,
      group_type: group.group_type,
      visibility: group.visibility,
      status: group.status,
      member_count: group._count.group_members,
      my_role: myRole,
      joined_at: joinedAt,
      created_at: group.created_at,
    }));

    return res.status(200).json({ success: true, data: { groups }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/join */
const joinGroup = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { invite_code: inviteCode } = req.body;

    const [invitation, user] = await Promise.all([
      prisma.group_invitations.findUnique({
        where: { invite_code: inviteCode },
        include: { group: { select: { status: true, deleted_at: true } } },
      }),
      prisma.users.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    if (!invitation) return next(createError('유효하지 않은 초대 코드입니다.', 404));
    if (invitation.group.status !== 'ACTIVE' || invitation.group.deleted_at) {
      return next(createError('그룹을 찾을 수 없습니다.', 404));
    }
    if (invitation.status !== 'PENDING') {
      return next(createError('만료되었거나 이미 사용된 초대 코드입니다.', 400));
    }
    if (invitation.expires_at <= new Date()) {
      await prisma.group_invitations.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      });
      return next(createError('만료되었거나 이미 사용된 초대 코드입니다.', 400));
    }

    const userIdMismatch = invitation.invitee_user_id && invitation.invitee_user_id !== userId;
    const emailMismatch =
      invitation.invitee_email && invitation.invitee_email.toLowerCase() !== user.email.toLowerCase();
    if (userIdMismatch || emailMismatch) {
      return next(createError('초대 대상 사용자와 일치하지 않습니다.', 403));
    }

    const existingMember = await getMyMember(invitation.group_id, userId);
    if (isActiveMember(existingMember)) return next(createError('이미 그룹 구성원입니다.', 409));

    const member = await prisma.$transaction(async (tx) => {
      const claimed = await tx.group_invitations.updateMany({
        where: { id: invitation.id, status: 'PENDING', expires_at: { gt: new Date() } },
        data: { status: 'ACCEPTED', invitee_user_id: userId },
      });
      if (claimed.count !== 1) throw createError('만료되었거나 이미 사용된 초대 코드입니다.', 400);

      return tx.group_members.upsert({
        where: { group_id_user_id: { group_id: invitation.group_id, user_id: userId } },
        create: {
          group_id: invitation.group_id,
          user_id: userId,
          group_role: 'MEMBER',
          status: 'ACTIVE',
          joined_at: new Date(),
        },
        update: { group_role: 'MEMBER', status: 'ACTIVE', joined_at: new Date() },
        select: { id: true, group_id: true, group_role: true, joined_at: true },
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        group_id: member.group_id,
        member_id: member.id,
        group_role: member.group_role,
        joined_at: member.joined_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id */
const getGroup = async (req, res, next) => {
  try {
    const group = await prisma.groups.findFirst({
      where: { id: req.params.id, status: 'ACTIVE', deleted_at: null },
      select: {
        id: true,
        name: true,
        description: true,
        group_type: true,
        visibility: true,
        status: true,
        created_at: true,
        group_members: {
          where: { status: 'ACTIVE' },
          select: { user_id: true, group_role: true },
        },
      },
    });
    if (!group) return next(createError('그룹을 찾을 수 없습니다.', 404));

    const myMember = group.group_members.find((member) => member.user_id === req.user.sub);
    if (group.visibility === 'PRIVATE' && !myMember) {
      return next(createError('비공개 그룹은 구성원만 조회할 수 있습니다.', 403));
    }

    return res.status(200).json({
      success: true,
      data: {
        group_id: group.id,
        name: group.name,
        description: group.description,
        group_type: group.group_type,
        visibility: group.visibility,
        status: group.status,
        member_count: group.group_members.length,
        my_role: myMember?.group_role ?? null,
        created_at: group.created_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/invite */
const inviteMember = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const { invitee_email: inviteeEmail, invitee_user_id: inviteeUserId, expires_in_days: days = 7 } = req.body;
    await requireGroup(groupId);

    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, ...MANAGER_ROLES)) {
      return next(createError('그룹 초대 권한이 없습니다 (OWNER 또는 MANAGER 필요).', 403));
    }
    if ((!inviteeEmail && !inviteeUserId) || (inviteeEmail && inviteeUserId)) {
      return next(createError('invitee_email 또는 invitee_user_id 중 하나는 필수입니다.', 400));
    }

    const invitee = inviteeUserId
      ? await prisma.users.findFirst({
          where: { id: inviteeUserId, status: 'ACTIVE', deleted_at: null },
          select: { id: true, email: true },
        })
      : await prisma.users.findFirst({
          where: { email: { equals: inviteeEmail, mode: 'insensitive' }, status: 'ACTIVE', deleted_at: null },
          select: { id: true, email: true },
        });
    if (inviteeUserId && !invitee) return next(createError('초대 대상 사용자를 찾을 수 없습니다.', 404));

    if (invitee) {
      const membership = await getMyMember(groupId, invitee.id);
      if (isActiveMember(membership)) return next(createError('이미 그룹 구성원입니다.', 409));
    }

    const now = new Date();
    const targetFilters = [
      ...(invitee?.id ? [{ invitee_user_id: invitee.id }] : []),
      ...(inviteeEmail
        ? [{ invitee_email: { equals: inviteeEmail, mode: 'insensitive' } }]
        : []),
    ];
    const invitation = await prisma.$transaction(async (tx) => {
      await tx.group_invitations.updateMany({
        where: {
          group_id: groupId,
          status: 'PENDING',
          expires_at: { lte: now },
          OR: targetFilters,
        },
        data: { status: 'EXPIRED' },
      });

      const pendingInvitation = await tx.group_invitations.findFirst({
        where: {
          group_id: groupId,
          status: 'PENDING',
          expires_at: { gt: now },
          OR: targetFilters,
        },
        select: { id: true },
      });
      if (pendingInvitation) throw createError('이미 처리 대기 중인 초대가 있습니다.', 409);

      return tx.group_invitations.create({
        data: {
          group_id: groupId,
          inviter_member_id: myMember.id,
          invitee_email: inviteeUserId ? null : inviteeEmail.toLowerCase(),
          invitee_user_id: inviteeUserId || invitee?.id || null,
          invite_code: randomBytes(12).toString('hex'),
          status: 'PENDING',
          expires_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
        },
        select: {
          id: true,
          invite_code: true,
          invitee_email: true,
          invitee_user_id: true,
          status: true,
          expires_at: true,
          created_at: true,
        },
      });
    });

    return res.status(201).json({
      success: true,
      data: {
        invitation_id: invitation.id,
        invite_code: invitation.invite_code,
        invitee_email: invitation.invitee_email,
        invitee_user_id: invitation.invitee_user_id,
        status: invitation.status,
        expires_at: invitation.expires_at,
        created_at: invitation.created_at,
      },
      error: '',
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return next(createError('이미 처리 대기 중인 초대가 있습니다.', 409));
    }
    next(err);
  }
};

/** PATCH /api/groups/:id/members/:memberId */
const updateMemberRole = async (req, res, next) => {
  try {
    const { id: groupId, memberId } = req.params;
    const { group_role: groupRole } = req.body;
    await requireGroup(groupId);

    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, 'OWNER')) {
      return next(createError('멤버 역할 변경은 OWNER만 가능합니다.', 403));
    }

    const target = await prisma.group_members.findFirst({
      where: { id: memberId, group_id: groupId, status: 'ACTIVE' },
    });
    if (!target) return next(createError('그룹 또는 멤버를 찾을 수 없습니다.', 404));
    if (target.id === myMember.id && groupRole !== 'OWNER') {
      return next(createError('OWNER 본인의 역할을 변경할 수 없습니다.', 403));
    }

    let updated;
    if (groupRole === 'OWNER' && target.id !== myMember.id) {
      updated = await prisma.$transaction(async (tx) => {
        await tx.group_members.update({
          where: { id: myMember.id },
          data: { group_role: 'MANAGER' },
        });
        return tx.group_members.update({
          where: { id: target.id },
          data: { group_role: 'OWNER' },
          select: { id: true, user_id: true, group_role: true, updated_at: true },
        });
      });
    } else {
      updated = await prisma.group_members.update({
        where: { id: target.id },
        data: { group_role: groupRole },
        select: { id: true, user_id: true, group_role: true, updated_at: true },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        member_id: updated.id,
        user_id: updated.user_id,
        group_role: updated.group_role,
        updated_at: updated.updated_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/groups/:id/members/:memberId */
const removeMember = async (req, res, next) => {
  try {
    const { id: groupId, memberId } = req.params;
    await requireGroup(groupId);

    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, ...MANAGER_ROLES)) return next(createError('멤버 내보내기 권한이 없습니다.', 403));

    const target = await prisma.group_members.findFirst({
      where: { id: memberId, group_id: groupId, status: 'ACTIVE' },
    });
    if (!target) return next(createError('멤버를 찾을 수 없습니다.', 404));
    if (target.group_role === 'OWNER') return next(createError('OWNER는 그룹에서 내보낼 수 없습니다.', 400));
    if (myMember.group_role === 'MANAGER' && target.group_role === 'MANAGER' && target.id !== myMember.id) {
      return next(createError('MANAGER는 다른 MANAGER를 내보낼 수 없습니다.', 403));
    }

    await prisma.group_members.update({ where: { id: target.id }, data: { status: 'REMOVED' } });
    return res.status(200).json({
      success: true,
      data: { member_id: target.id, status: 'REMOVED' },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/dashboard */
const getDashboard = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!isActiveMember(myMember)) return next(createError('그룹 구성원만 대시보드를 조회할 수 있습니다.', 403));

    const isManager = hasRole(myMember, ...MANAGER_ROLES);
    const memberFilter = isManager ? Prisma.empty : Prisma.sql`AND group_member_id = ${myMember.id}`;
    const rows = await prisma.$queryRaw(
      Prisma.sql`
        SELECT *
        FROM v_group_member_stats
        WHERE group_id = ${groupId}
        ${memberFilter}
        ORDER BY group_role, joined_at
      `,
    );
    const members = rows.map((row) => ({
      group_member_id: row.group_member_id,
      user_id: row.user_id,
      group_role: row.group_role,
      nickname: row.nickname,
      profile_image_url: row.profile_image_url,
      total_sessions: Number(row.total_sessions),
      total_study_seconds: Number(row.total_study_seconds),
      avg_focus_score: row.avg_focus_score === null ? null : Number(row.avg_focus_score),
      last_session_at: row.last_session_at,
    }));

    return res.status(200).json({
      success: true,
      data: { group_id: groupId, scope: isManager ? 'all_members' : 'self', members },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/goals */
const createGoal = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const { title, description = null, target_study_minutes = null, target_focus_score = null, start_date: startDateValue, end_date: endDateValue } = req.body;
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, ...MANAGER_ROLES)) {
      return next(createError('목표 생성 권한이 없습니다 (OWNER 또는 MANAGER 필요).', 403));
    }

    const startDate = parseDateOnly(startDateValue);
    const endDate = parseDateOnly(endDateValue);
    if (endDate < startDate) return next(createError('end_date는 start_date 이후여야 합니다.', 400));

    const goal = await prisma.group_goals.create({
      data: {
        group_id: groupId,
        created_by_member_id: myMember.id,
        title,
        description,
        target_study_minutes,
        target_focus_score,
        start_date: startDate,
        end_date: endDate,
        status: 'ACTIVE',
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        goal_id: goal.id,
        group_id: goal.group_id,
        title: goal.title,
        description: goal.description,
        target_study_minutes: goal.target_study_minutes,
        target_focus_score: goal.target_focus_score,
        start_date: dateOnly(goal.start_date),
        end_date: dateOnly(goal.end_date),
        status: goal.status,
        created_at: goal.created_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/goals */
const getGoals = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!isActiveMember(myMember)) return next(createError('그룹 구성원만 목표를 조회할 수 있습니다.', 403));

    const goals = await prisma.group_goals.findMany({
      where: { group_id: groupId, ...(req.query.status && { status: req.query.status }) },
      orderBy: { created_at: 'desc' },
      include: {
        assignees: {
          where: { group_member: { status: 'ACTIVE' } },
          select: { group_member_id: true },
        },
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        goals: goals.map((goal) => ({
          goal_id: goal.id,
          title: goal.title,
          description: goal.description,
          target_study_minutes: goal.target_study_minutes,
          target_focus_score: goal.target_focus_score,
          start_date: dateOnly(goal.start_date),
          end_date: dateOnly(goal.end_date),
          status: goal.status,
          assignee_count: goal.assignees.length,
          is_assigned_to_me:
            goal.assignees.length === 0 ||
            goal.assignees.some((assignee) => assignee.group_member_id === myMember.id),
          created_at: goal.created_at,
        })),
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/groups/:id/goals/:goalId/assignees */
const assignGoal = async (req, res, next) => {
  try {
    const { id: groupId, goalId } = req.params;
    const memberIds = req.body.group_member_ids ?? [];
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, ...MANAGER_ROLES)) {
      return next(createError('목표 배정 권한이 없습니다 (OWNER 또는 MANAGER 필요).', 403));
    }

    const goal = await prisma.group_goals.findFirst({ where: { id: goalId, group_id: groupId } });
    if (!goal) return next(createError('그룹 또는 목표를 찾을 수 없습니다.', 404));

    const uniqueMemberIds = [...new Set(memberIds)];
    if (uniqueMemberIds.length !== memberIds.length) {
      return next(createError('group_member_ids에 중복된 멤버가 포함되어 있습니다.', 400));
    }

    if (uniqueMemberIds.length === 0) {
      await prisma.group_goal_assignees.deleteMany({ where: { group_goal_id: goalId } });
      return res.status(201).json({
        success: true,
        data: { goal_id: goalId, assignees: [], is_group_wide: true },
        error: '',
      });
    }

    const members = await prisma.group_members.findMany({
      where: { id: { in: uniqueMemberIds }, group_id: groupId, status: 'ACTIVE' },
      select: {
        id: true,
        user_id: true,
        user: { select: { user_profile: { select: { nickname: true } } } },
      },
    });
    if (members.length !== uniqueMemberIds.length) {
      return next(createError('group_member_ids에 유효하지 않은 멤버가 포함되어 있습니다.', 400));
    }

    const existing = await prisma.group_goal_assignees.findFirst({
      where: { group_goal_id: goalId, group_member_id: { in: uniqueMemberIds } },
      select: { id: true },
    });
    if (existing) return next(createError('이미 배정된 멤버입니다.', 409));

    await prisma.group_goal_assignees.createMany({
      data: uniqueMemberIds.map((groupMemberId) => ({
        group_goal_id: goalId,
        group_member_id: groupMemberId,
      })),
    });
    const assignments = await prisma.group_goal_assignees.findMany({
      where: { group_goal_id: goalId, group_member_id: { in: uniqueMemberIds } },
      select: { id: true, group_member_id: true },
    });
    const assignmentByMember = new Map(
      assignments.map((assignment) => [assignment.group_member_id, assignment.id]),
    );

    return res.status(201).json({
      success: true,
      data: {
        goal_id: goalId,
        assignees: members.map((member) => ({
          assignment_id: assignmentByMember.get(member.id),
          group_member_id: member.id,
          user_id: member.user_id,
          nickname: member.user.user_profile?.nickname ?? null,
        })),
        is_group_wide: false,
      },
      error: '',
    });
  } catch (err) {
    if (err.code === 'P2002') return next(createError('이미 배정된 멤버입니다.', 409));
    next(err);
  }
};

/** POST /api/groups/:id/feedbacks */
const createFeedback = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const { target_member_id: targetMemberId, content, session_id: sessionId = null } = req.body;
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!hasRole(myMember, ...MANAGER_ROLES)) {
      return next(createError('피드백 작성 권한이 없습니다 (OWNER 또는 MANAGER 필요).', 403));
    }

    const target = await prisma.group_members.findFirst({
      where: { id: targetMemberId, group_id: groupId, status: 'ACTIVE' },
      select: { id: true, user_id: true },
    });
    if (!target) return next(createError('대상 멤버가 해당 그룹에 속하지 않습니다.', 403));

    if (sessionId) {
      const session = await prisma.sessions.findUnique({
        where: { id: sessionId },
        select: { user_id: true },
      });
      if (!session) return next(createError('참조 세션을 찾을 수 없습니다.', 404));
      if (session.user_id !== target.user_id) {
        return next(createError('참조 세션이 대상 멤버의 세션이 아닙니다.', 403));
      }
    }

    const feedback = await prisma.manager_feedbacks.create({
      data: {
        group_id: groupId,
        manager_member_id: myMember.id,
        target_member_id: target.id,
        session_id: sessionId,
        content,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        feedback_id: feedback.id,
        group_id: feedback.group_id,
        target_member_id: feedback.target_member_id,
        manager_member_id: feedback.manager_member_id,
        session_id: feedback.session_id,
        content: feedback.content,
        created_at: feedback.created_at,
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/groups/:id/feedbacks */
const getFeedbacks = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const page = Number.parseInt(req.query.page || '1', 10);
    const limit = Number.parseInt(req.query.limit || '20', 10);
    const requestedTarget = req.query.target_member_id;
    await requireGroup(groupId);
    const myMember = await getMyMember(groupId, req.user.sub);
    if (!isActiveMember(myMember)) {
      return next(createError('그룹 구성원만 피드백을 조회할 수 있습니다.', 403));
    }

    const isManager = hasRole(myMember, ...MANAGER_ROLES);
    if (!isManager && requestedTarget && requestedTarget !== myMember.id) {
      return next(createError('다른 구성원의 피드백을 조회할 권한이 없습니다.', 403));
    }
    const where = {
      group_id: groupId,
      target_member_id: isManager ? requestedTarget : myMember.id,
    };
    if (!where.target_member_id) delete where.target_member_id;

    const [feedbacks, total] = await prisma.$transaction([
      prisma.manager_feedbacks.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          target_member: {
            select: {
              id: true,
              user: { select: { id: true, user_profile: { select: { nickname: true } } } },
            },
          },
          manager_member: {
            select: {
              id: true,
              user: { select: { id: true, user_profile: { select: { nickname: true } } } },
            },
          },
        },
      }),
      prisma.manager_feedbacks.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        feedbacks: feedbacks.map((feedback) => ({
          feedback_id: feedback.id,
          target_member_id: feedback.target_member_id,
          target_user: {
            user_id: feedback.target_member.user.id,
            nickname: feedback.target_member.user.user_profile?.nickname ?? null,
          },
          manager_member_id: feedback.manager_member_id,
          manager_user: {
            user_id: feedback.manager_member.user.id,
            nickname: feedback.manager_member.user.user_profile?.nickname ?? null,
          },
          session_id: feedback.session_id,
          content: feedback.content,
          created_at: feedback.created_at,
        })),
        pagination: { page, limit, total },
      },
      error: '',
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createGroup,
  getMyGroups,
  joinGroup,
  getGroup,
  inviteMember,
  updateMemberRole,
  removeMember,
  getDashboard,
  createGoal,
  getGoals,
  assignGoal,
  createFeedback,
  getFeedbacks,
};
