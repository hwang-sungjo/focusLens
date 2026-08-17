-- 동일 사용자 쌍에는 동시에 하나의 PENDING 친구 요청만 허용한다.
CREATE UNIQUE INDEX "user_connection_requests_pending_pair_key"
ON "user_connection_requests" (
    LEAST("requester_user_id", "receiver_user_id"),
    GREATEST("requester_user_id", "receiver_user_id")
)
WHERE "status" = 'PENDING';

-- group_id가 NULL인 PUBLIC/FRIENDS 공유도 DB에서 동시 중복 생성을 차단한다.
CREATE UNIQUE INDEX "session_shares_session_scope_without_group_key"
ON "session_shares" ("session_id", "share_scope")
WHERE "group_id" IS NULL;

-- 기간별 랭킹을 계산할 수 있도록 v_rankings를 일별 집계 원천 View로 재구성한다.
DROP VIEW IF EXISTS v_rankings;

CREATE VIEW v_rankings AS
WITH session_stats AS (
    SELECT
        s.id AS session_id,
        s.user_id,
        s.started_at::DATE AS activity_date,
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
    ss.activity_date,
    u.id AS user_id,
    up.nickname,
    up.profile_image_url,
    SUM(ss.focus_score_sum)::NUMERIC AS focus_score_sum,
    SUM(ss.focus_log_count)::INT AS focus_log_count,
    SUM(ss.study_seconds)::INT AS total_study_seconds,
    COUNT(ss.session_id)::INT AS session_count
FROM users u
JOIN user_privacy_settings ups ON ups.user_id = u.id
                               AND ups.ranking_participation = TRUE
JOIN session_stats ss ON ss.user_id = u.id
LEFT JOIN user_profiles up ON up.user_id = u.id
WHERE u.status = 'ACTIVE'
  AND u.deleted_at IS NULL
GROUP BY ss.activity_date, u.id, up.nickname, up.profile_image_url;

COMMENT ON VIEW v_rankings IS
    '일별 랭킹 원천 View. ranking_participation=TRUE 사용자의 집중도 합계·로그 수·학습시간·세션 수를 집계. API에서 기간과 범위를 적용해 순위를 산출한다.';
