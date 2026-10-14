-- 그룹 통계는 사용자가 group_data_sharing을 허용한 완료 세션만 집계한다.
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
    JOIN user_privacy_settings ups ON ups.user_id = s.user_id
                                  AND ups.group_data_sharing = TRUE
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
    '그룹 데이터 공유를 허용한 구성원의 완료 세션 수·학습시간·가중 평균 집중도 통계.';

-- PostgreSQL 연결 시간대와 관계없이 랭킹 일자 버킷을 UTC로 고정한다.
DROP VIEW IF EXISTS v_rankings;

CREATE VIEW v_rankings AS
WITH session_stats AS (
    SELECT
        s.id AS session_id,
        s.user_id,
        (s.started_at AT TIME ZONE 'UTC')::DATE AS activity_date,
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
    'UTC 세션 시작일 기준 랭킹 원천 View. ranking_participation=TRUE 사용자의 완료 세션만 집계.';
