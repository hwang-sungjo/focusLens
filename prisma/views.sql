-- FocusLens 조회 View 5개. 모든 집계 값은 기본 테이블에 중복 저장하지 않는다.

CREATE OR REPLACE VIEW v_session_share_reaction_counts AS
SELECT sr.session_share_id, sr.reaction_type,
    COUNT(*)::INT AS reaction_count,
    COUNT(*) FILTER (WHERE sr.reaction_type = 'LIKE')::INT AS like_count,
    COUNT(*) FILTER (WHERE sr.reaction_type = 'CHEER')::INT AS cheer_count,
    COUNT(*) FILTER (WHERE sr.reaction_type = 'EMPATHY')::INT AS empathy_count
FROM session_reactions sr
GROUP BY sr.session_share_id, sr.reaction_type;

COMMENT ON VIEW v_session_share_reaction_counts IS
    '공유 세션별 공감 반응(LIKE/CHEER/EMPATHY) COUNT 집계.';

-- 원본 및 세 Roll-up tier를 세션별 가중 합계로 통합한다.
CREATE OR REPLACE VIEW v_session_metric_totals AS
WITH metric_sources AS (
    SELECT session_id,
        gaze_score::NUMERIC AS gaze_score_sum, blink_score::NUMERIC AS blink_score_sum,
        head_score::NUMERIC AS head_score_sum, focus_score::NUMERIC AS focus_score_sum,
        1::BIGINT AS log_count,
        (attention_state = 'FOCUSED')::INT AS focused_count,
        (attention_state = 'NORMAL')::INT AS normal_count,
        (attention_state = 'DISTRACTED')::INT AS distracted_count,
        (NOT face_detected)::INT AS face_not_detected_count
    FROM concentration_logs
    UNION ALL
    SELECT session_id, avg_gaze_score::NUMERIC * log_count, avg_blink_score::NUMERIC * log_count,
        avg_head_score::NUMERIC * log_count, avg_focus_score::NUMERIC * log_count,
        log_count::BIGINT, focused_count, normal_count, distracted_count, face_not_detected_count
    FROM hourly_stats
    UNION ALL
    SELECT session_id, avg_gaze_score::NUMERIC * log_count, avg_blink_score::NUMERIC * log_count,
        avg_head_score::NUMERIC * log_count, avg_focus_score::NUMERIC * log_count,
        log_count::BIGINT, focused_count, normal_count, distracted_count, face_not_detected_count
    FROM daily_stats
    UNION ALL
    SELECT session_id, avg_gaze_score::NUMERIC * log_count, avg_blink_score::NUMERIC * log_count,
        avg_head_score::NUMERIC * log_count, avg_focus_score::NUMERIC * log_count,
        log_count::BIGINT, focused_count, normal_count, distracted_count, face_not_detected_count
    FROM weekly_stats
)
SELECT session_id,
    SUM(gaze_score_sum)::NUMERIC AS gaze_score_sum,
    SUM(blink_score_sum)::NUMERIC AS blink_score_sum,
    SUM(head_score_sum)::NUMERIC AS head_score_sum,
    SUM(focus_score_sum)::NUMERIC AS focus_score_sum,
    SUM(log_count)::BIGINT AS log_count,
    SUM(focused_count)::BIGINT AS focused_count,
    SUM(normal_count)::BIGINT AS normal_count,
    SUM(distracted_count)::BIGINT AS distracted_count,
    SUM(face_not_detected_count)::BIGINT AS face_not_detected_count,
    ROUND(SUM(gaze_score_sum) / SUM(log_count), 2) AS avg_gaze_score,
    ROUND(SUM(blink_score_sum) / SUM(log_count), 2) AS avg_blink_score,
    ROUND(SUM(head_score_sum) / SUM(log_count), 2) AS avg_head_score,
    ROUND(SUM(focus_score_sum) / SUM(log_count), 2) AS avg_focus_score
FROM metric_sources GROUP BY session_id;

COMMENT ON VIEW v_session_metric_totals IS
    '원본·시간·일·주 tier의 세션별 가중 합계, 평균, 상태 및 얼굴 미검출 건수.';

CREATE OR REPLACE VIEW v_user_session_summaries AS
SELECT s.id AS session_id, s.user_id, s.started_at, s.ended_at, s.status, s.created_at,
    CASE WHEN s.ended_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT ELSE NULL END AS duration_seconds,
    mt.avg_focus_score, COALESCE(mt.log_count, 0)::INT AS log_count,
    mt.avg_gaze_score, mt.avg_blink_score, mt.avg_head_score,
    COALESCE(mt.focused_count, 0)::INT AS focused_count,
    COALESCE(mt.normal_count, 0)::INT AS normal_count,
    COALESCE(mt.distracted_count, 0)::INT AS distracted_count,
    r.id AS report_id, r.summary_json, r.created_at AS report_created_at
FROM sessions s
LEFT JOIN v_session_metric_totals mt ON mt.session_id = s.id
LEFT JOIN reports r ON r.session_id = s.id;

COMMENT ON VIEW v_user_session_summaries IS
    'Roll-up 이후에도 유지되는 세션 평균·기간·로그 수·상태 분포 요약.';

DROP VIEW IF EXISTS v_group_member_stats;
CREATE VIEW v_group_member_stats AS
WITH session_stats AS (
    SELECT s.id AS session_id, s.user_id, s.started_at,
        GREATEST(EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT, 0) AS study_seconds,
        COALESCE(mt.focus_score_sum, 0)::NUMERIC AS focus_score_sum,
        COALESCE(mt.log_count, 0)::BIGINT AS focus_log_count
    FROM sessions s
    JOIN user_privacy_settings ups ON ups.user_id = s.user_id AND ups.group_data_sharing = TRUE
    LEFT JOIN v_session_metric_totals mt ON mt.session_id = s.id
    WHERE s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
)
SELECT gm.group_id, gm.id AS group_member_id, gm.user_id, gm.group_role,
    gm.status AS member_status, gm.joined_at, u.name AS user_name,
    up.nickname, up.profile_image_url,
    COUNT(ss.session_id)::INT AS total_sessions,
    COALESCE(SUM(ss.study_seconds), 0)::INT AS total_study_seconds,
    CASE WHEN SUM(ss.focus_log_count) > 0
      THEN ROUND(SUM(ss.focus_score_sum) / SUM(ss.focus_log_count), 2) ELSE NULL END AS avg_focus_score,
    MAX(ss.started_at) AS last_session_at
FROM group_members gm
JOIN users u ON u.id = gm.user_id
LEFT JOIN user_profiles up ON up.user_id = gm.user_id
LEFT JOIN session_stats ss ON ss.user_id = gm.user_id
WHERE gm.status = 'ACTIVE'
GROUP BY gm.group_id, gm.id, gm.user_id, gm.group_role, gm.status, gm.joined_at,
    u.name, up.nickname, up.profile_image_url;

COMMENT ON VIEW v_group_member_stats IS
    '그룹 데이터 공유를 허용한 구성원의 완료 세션 수·학습시간·가중 평균 집중도.';

DROP VIEW IF EXISTS v_rankings;
CREATE VIEW v_rankings AS
WITH session_stats AS (
    SELECT s.id AS session_id, s.user_id,
        s.started_at::DATE AS activity_date,
        GREATEST(EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT, 0) AS study_seconds,
        COALESCE(mt.focus_score_sum, 0)::NUMERIC AS focus_score_sum,
        COALESCE(mt.log_count, 0)::BIGINT AS focus_log_count
    FROM sessions s
    LEFT JOIN v_session_metric_totals mt ON mt.session_id = s.id
    WHERE s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
)
SELECT ss.activity_date, u.id AS user_id, up.nickname, up.profile_image_url,
    SUM(ss.focus_score_sum)::NUMERIC AS focus_score_sum,
    SUM(ss.focus_log_count)::INT AS focus_log_count,
    SUM(ss.study_seconds)::INT AS total_study_seconds,
    COUNT(ss.session_id)::INT AS session_count
FROM users u
JOIN user_privacy_settings ups ON ups.user_id = u.id AND ups.ranking_participation = TRUE
JOIN session_stats ss ON ss.user_id = u.id
LEFT JOIN user_profiles up ON up.user_id = u.id
WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL
GROUP BY ss.activity_date, u.id, up.nickname, up.profile_image_url;

COMMENT ON VIEW v_rankings IS
    'UTC 세션 시작일 기준 랭킹 원천. 원본과 Roll-up tier를 함께 집계.';
