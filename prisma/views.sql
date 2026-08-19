-- =============================================================================
-- prisma/views.sql
-- FocusLens 조회용 View 4개
-- 참고: docs/erd.md §6 조회용 View 권장 사항
--
-- 설계 원칙:
--   - 파생 데이터(공감 수, 평균 집중도, 랭킹 등)는 기본 테이블에 저장하지 않음
--   - sessions에 avg_focus_score / duration_seconds 컬럼 없음 → 항상 이 View로 계산
--   - v_rankings는 ranking_participation = true 사용자만 집계
--
-- 적용 방법:
--   docker exec -i focuslens_postgres psql -U focuslens -d focuslens < prisma/views.sql
--   또는 psql $DATABASE_URL -f prisma/views.sql
-- =============================================================================


-- =============================================================================
-- 1. v_session_share_reaction_counts
--    session_reactions를 session_share_id, reaction_type 기준으로 집계
--    피드에서 좋아요/응원/공감 개수 표시에 사용
-- =============================================================================
CREATE OR REPLACE VIEW v_session_share_reaction_counts AS
SELECT
    sr.session_share_id,
    sr.reaction_type,
    COUNT(*)::INT                   AS reaction_count,
    -- 피벗 컬럼: 각 reaction_type별 개수를 한 행에서 바로 접근할 수 있도록 제공
    COUNT(*) FILTER (WHERE sr.reaction_type = 'LIKE')::INT    AS like_count,
    COUNT(*) FILTER (WHERE sr.reaction_type = 'CHEER')::INT   AS cheer_count,
    COUNT(*) FILTER (WHERE sr.reaction_type = 'EMPATHY')::INT AS empathy_count
FROM session_reactions sr
GROUP BY
    sr.session_share_id,
    sr.reaction_type;

COMMENT ON VIEW v_session_share_reaction_counts IS
    '공유 세션별 공감 반응(LIKE/CHEER/EMPATHY) COUNT 집계. 피드 카드 렌더링에 사용.';


-- =============================================================================
-- 2. v_user_session_summaries
--    sessions, concentration_logs, reports 조인
--    세션 카드에 필요한 avg_focus_score, duration_seconds, log_count를 계산
--    sessions 테이블에 저장하지 않는 파생값을 조회 시 산출
-- =============================================================================
CREATE OR REPLACE VIEW v_user_session_summaries AS
SELECT
    s.id                                                        AS session_id,
    s.user_id,
    s.started_at,
    s.ended_at,
    s.status,
    s.created_at,

    -- 총 학습시간 (초) — sessions에 duration_seconds 컬럼 저장 금지, 여기서 계산
    CASE
        WHEN s.ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT
        ELSE NULL
    END                                                         AS duration_seconds,

    -- 평균 집중도 — sessions에 avg_focus_score 컬럼 저장 금지, concentration_logs에서 계산
    ROUND(AVG(cl.focus_score)::NUMERIC, 2)                     AS avg_focus_score,

    -- 분 단위 로그 수
    COUNT(cl.id)::INT                                           AS log_count,

    -- gaze/blink/head 분리 평균
    ROUND(AVG(cl.gaze_score)::NUMERIC,  2)                     AS avg_gaze_score,
    ROUND(AVG(cl.blink_score)::NUMERIC, 2)                     AS avg_blink_score,
    ROUND(AVG(cl.head_score)::NUMERIC,  2)                     AS avg_head_score,

    -- attention 상태 분포
    COUNT(cl.id) FILTER (WHERE cl.attention_state = 'FOCUSED')::INT    AS focused_count,
    COUNT(cl.id) FILTER (WHERE cl.attention_state = 'NORMAL')::INT     AS normal_count,
    COUNT(cl.id) FILTER (WHERE cl.attention_state = 'DISTRACTED')::INT AS distracted_count,

    -- 리포트 존재 여부
    r.id                                                        AS report_id,
    r.summary_json,
    r.created_at                                                AS report_created_at

FROM sessions s
LEFT JOIN concentration_logs cl ON cl.session_id = s.id
LEFT JOIN reports             r  ON r.session_id  = s.id
GROUP BY
    s.id,
    s.user_id,
    s.started_at,
    s.ended_at,
    s.status,
    s.created_at,
    r.id,
    r.summary_json,
    r.created_at;

COMMENT ON VIEW v_user_session_summaries IS
    '세션 요약 View. avg_focus_score·duration_seconds는 sessions 테이블에 저장하지 않고 여기서 계산. '
    '내 기록 화면 및 소셜 피드 세션 카드 표시에 사용.';


-- =============================================================================
-- 3. v_group_member_stats
--    group_members 기준 user별 그룹 내 총 학습시간, 평균 집중도 집계
--    관리자 그룹 대시보드에서 구성원별 기간별 학습 통계 조회에 사용
--    (기간 필터는 이 View를 WHERE 절로 감싸서 적용)
-- =============================================================================
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


-- =============================================================================
-- 4. v_rankings
--    ranking_participation = true 사용자의 일별 집계 원천
--    API에서 daily/weekly 기간과 global/friends/group 범위를 적용한 뒤 순위를 산출
--    설계 원칙: 랭킹 파생값은 기본 테이블에 저장하지 않고 이 View에서 산출
-- =============================================================================
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
    '일별 랭킹 원천 View. ranking_participation=TRUE 사용자의 집중도 합계·로그 수·학습시간·세션 수를 집계. '
    'API에서 기간과 친구/그룹 범위를 적용한 뒤 최종 순위를 산출한다.';
