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
CREATE OR REPLACE VIEW v_group_member_stats AS
SELECT
    gm.group_id,
    gm.id                                                           AS group_member_id,
    gm.user_id,
    gm.group_role,
    gm.status                                                       AS member_status,
    gm.joined_at,

    -- 유저 기본 정보
    u.name                                                          AS user_name,
    up.nickname,
    up.profile_image_url,

    -- 세션 통계 (해당 유저의 전체 세션 기준)
    COUNT(DISTINCT s.id)::INT                                       AS total_sessions,

    -- 총 학습시간 (완료된 세션만, 초 단위)
    COALESCE(
        SUM(
            CASE
                WHEN s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT
                ELSE 0
            END
        )::INT,
        0
    )                                                               AS total_study_seconds,

    -- 평균 집중도 (concentration_logs 전체 기준)
    ROUND(AVG(cl.focus_score)::NUMERIC, 2)                         AS avg_focus_score,

    -- 최근 세션 시작 시각
    MAX(s.started_at)                                               AS last_session_at

FROM group_members gm
JOIN users            u  ON u.id  = gm.user_id
LEFT JOIN user_profiles up ON up.user_id = gm.user_id
LEFT JOIN sessions    s  ON s.user_id = gm.user_id
                        AND s.status = 'COMPLETED'
LEFT JOIN concentration_logs cl ON cl.session_id = s.id
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
    '그룹 구성원별 학습 통계. OWNER/MANAGER 전용 대시보드에서 사용. '
    '기간 필터가 필요한 경우 이 View에 WHERE s.started_at BETWEEN ... 조건을 추가해 조회.';


-- =============================================================================
-- 4. v_rankings
--    ranking_participation = true인 사용자만 집계
--    focus_score 기준 내림차순 정렬
--    설계 원칙: 랭킹 파생값은 기본 테이블에 저장하지 않고 이 View에서 산출
--    조회 빈도가 높아지면 MATERIALIZED VIEW 전환 검토 (docs/erd.md §6 참고)
-- =============================================================================
CREATE OR REPLACE VIEW v_rankings AS
SELECT
    -- 랭킹 순위 (avg_focus_score 기준 내림차순)
    ROW_NUMBER() OVER (
        ORDER BY ROUND(AVG(cl.focus_score)::NUMERIC, 2) DESC
    )::INT                                                          AS rank,

    u.id                                                            AS user_id,
    u.name,
    up.nickname,
    up.profile_image_url,

    -- 집중도 지표
    ROUND(AVG(cl.focus_score)::NUMERIC,  2)                        AS avg_focus_score,
    ROUND(AVG(cl.gaze_score)::NUMERIC,   2)                        AS avg_gaze_score,
    ROUND(AVG(cl.blink_score)::NUMERIC,  2)                        AS avg_blink_score,
    ROUND(AVG(cl.head_score)::NUMERIC,   2)                        AS avg_head_score,

    -- 학습시간 지표 (완료된 세션 합산, 초 단위)
    COALESCE(
        SUM(
            CASE
                WHEN s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INT
                ELSE 0
            END
        )::INT,
        0
    )                                                               AS total_study_seconds,

    -- 세션 수
    COUNT(DISTINCT s.id)::INT                                       AS total_sessions,

    -- 로그 수
    COUNT(cl.id)::INT                                               AS total_logs

FROM users u
-- 반드시 ranking_participation = true 조건 적용 (ERD 보안 원칙)
JOIN user_privacy_settings ups ON ups.user_id = u.id
                               AND ups.ranking_participation = TRUE
LEFT JOIN user_profiles    up  ON up.user_id = u.id
LEFT JOIN sessions         s   ON s.user_id  = u.id
                               AND s.status = 'COMPLETED'
LEFT JOIN concentration_logs cl ON cl.session_id = s.id
-- 탈퇴/정지 유저 제외
WHERE u.status  = 'ACTIVE'
  AND u.deleted_at IS NULL
GROUP BY
    u.id,
    u.name,
    up.nickname,
    up.profile_image_url
-- 로그가 하나도 없는 유저(avg_focus_score=NULL)는 제외
HAVING AVG(cl.focus_score) IS NOT NULL
ORDER BY avg_focus_score DESC;

COMMENT ON VIEW v_rankings IS
    '전체 랭킹 View. ranking_participation=TRUE 사용자만 집계. '
    'focus_score 기준 내림차순. '
    '친구/그룹 랭킹은 이 View에 user_id IN (...) 필터를 추가해 조회. '
    '조회 빈도가 높아지면 MATERIALIZED VIEW로 전환 검토 (docs/erd.md §6).';
