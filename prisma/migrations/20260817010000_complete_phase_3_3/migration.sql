-- 활성 그룹에는 OWNER가 한 명만 존재하도록 보장한다.
CREATE UNIQUE INDEX "group_members_one_active_owner_key"
ON "group_members" ("group_id")
WHERE "group_role" = 'OWNER' AND "status" = 'ACTIVE';

-- 초대 대상과 목표 기간의 기본 데이터 무결성을 DB에서도 보장한다.
ALTER TABLE "group_invitations"
    ADD CONSTRAINT "group_invitations_target_required_check"
        CHECK ("invitee_email" IS NOT NULL OR "invitee_user_id" IS NOT NULL);

ALTER TABLE "group_goals"
    ADD CONSTRAINT "group_goals_date_range_check"
        CHECK ("end_date" >= "start_date");

-- 같은 대상에 대한 활성 초대의 동시 중복 생성을 차단한다.
CREATE UNIQUE INDEX "group_invitations_pending_user_key"
ON "group_invitations" ("group_id", "invitee_user_id")
WHERE "status" = 'PENDING' AND "invitee_user_id" IS NOT NULL;

CREATE UNIQUE INDEX "group_invitations_pending_email_key"
ON "group_invitations" ("group_id", LOWER("invitee_email"))
WHERE "status" = 'PENDING' AND "invitee_email" IS NOT NULL;

-- 로그 조인으로 세션 시간이 중복 합산되지 않도록 그룹 통계 View를 재구성한다.
DROP VIEW IF EXISTS v_group_member_stats;

CREATE VIEW v_group_member_stats AS
WITH session_stats AS (
    SELECT
        s.id AS session_id,
        s.user_id,
        s.started_at,
        GREATEST(EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT, 0)
            AS study_seconds,
        COALESCE(SUM(cl.focus_score), 0)::NUMERIC AS focus_score_sum,
        COUNT(cl.id)::INT AS focus_log_count
    FROM sessions s
    LEFT JOIN concentration_logs cl ON cl.session_id = s.id
    WHERE s.status = 'COMPLETED'
      AND s.ended_at IS NOT NULL
    GROUP BY s.id, s.user_id, s.started_at, s.ended_at
)
SELECT
    gm.group_id,
    gm.id AS group_member_id,
    gm.user_id,
    gm.group_role,
    gm.status AS member_status,
    gm.joined_at,
    u.name AS user_name,
    up.nickname,
    up.profile_image_url,
    COUNT(ss.session_id)::INT AS total_sessions,
    COALESCE(SUM(ss.study_seconds), 0)::INT AS total_study_seconds,
    CASE
        WHEN SUM(ss.focus_log_count) > 0
        THEN ROUND(SUM(ss.focus_score_sum) / SUM(ss.focus_log_count), 2)
        ELSE NULL
    END AS avg_focus_score,
    MAX(ss.started_at) AS last_session_at
FROM group_members gm
JOIN users u ON u.id = gm.user_id
LEFT JOIN user_profiles up ON up.user_id = gm.user_id
LEFT JOIN session_stats ss ON ss.user_id = gm.user_id
WHERE gm.status = 'ACTIVE'
GROUP BY
    gm.group_id,
    gm.id,
    gm.user_id,
    gm.group_role,
    gm.status,
    gm.joined_at,
    u.name,
    up.nickname,
    up.profile_image_url;

COMMENT ON VIEW v_group_member_stats IS
    '그룹 구성원별 완료 세션 수·학습시간·가중 평균 집중도 통계. OWNER/MANAGER 대시보드에서 사용.';
