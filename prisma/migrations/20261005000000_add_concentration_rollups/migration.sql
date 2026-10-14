-- Phase 4-4: concentration log roll-up tiers and roll-up aware read views.

CREATE TABLE "hourly_stats" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "avg_gaze_score" DOUBLE PRECISION NOT NULL,
    "avg_blink_score" DOUBLE PRECISION NOT NULL,
    "avg_head_score" DOUBLE PRECISION NOT NULL,
    "avg_focus_score" DOUBLE PRECISION NOT NULL,
    "log_count" INTEGER NOT NULL,
    "focused_count" INTEGER NOT NULL DEFAULT 0,
    "normal_count" INTEGER NOT NULL DEFAULT 0,
    "distracted_count" INTEGER NOT NULL DEFAULT 0,
    "face_not_detected_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hourly_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hourly_stats_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "hourly_stats_counts_check" CHECK (
      "log_count" > 0
      AND "focused_count" >= 0 AND "normal_count" >= 0 AND "distracted_count" >= 0
      AND "face_not_detected_count" >= 0
      AND "focused_count" + "normal_count" + "distracted_count" = "log_count"
      AND "face_not_detected_count" <= "log_count"
    ),
    CONSTRAINT "hourly_stats_scores_check" CHECK (
      "avg_gaze_score" BETWEEN 0 AND 100 AND "avg_blink_score" BETWEEN 0 AND 100
      AND "avg_head_score" BETWEEN 0 AND 100 AND "avg_focus_score" BETWEEN 0 AND 100
    )
);

CREATE TABLE "daily_stats" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "avg_gaze_score" DOUBLE PRECISION NOT NULL,
    "avg_blink_score" DOUBLE PRECISION NOT NULL,
    "avg_head_score" DOUBLE PRECISION NOT NULL,
    "avg_focus_score" DOUBLE PRECISION NOT NULL,
    "log_count" INTEGER NOT NULL,
    "focused_count" INTEGER NOT NULL DEFAULT 0,
    "normal_count" INTEGER NOT NULL DEFAULT 0,
    "distracted_count" INTEGER NOT NULL DEFAULT 0,
    "face_not_detected_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "daily_stats_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "daily_stats_counts_check" CHECK (
      "log_count" > 0
      AND "focused_count" >= 0 AND "normal_count" >= 0 AND "distracted_count" >= 0
      AND "face_not_detected_count" >= 0
      AND "focused_count" + "normal_count" + "distracted_count" = "log_count"
      AND "face_not_detected_count" <= "log_count"
    ),
    CONSTRAINT "daily_stats_scores_check" CHECK (
      "avg_gaze_score" BETWEEN 0 AND 100 AND "avg_blink_score" BETWEEN 0 AND 100
      AND "avg_head_score" BETWEEN 0 AND 100 AND "avg_focus_score" BETWEEN 0 AND 100
    )
);

CREATE TABLE "weekly_stats" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "avg_gaze_score" DOUBLE PRECISION NOT NULL,
    "avg_blink_score" DOUBLE PRECISION NOT NULL,
    "avg_head_score" DOUBLE PRECISION NOT NULL,
    "avg_focus_score" DOUBLE PRECISION NOT NULL,
    "log_count" INTEGER NOT NULL,
    "focused_count" INTEGER NOT NULL DEFAULT 0,
    "normal_count" INTEGER NOT NULL DEFAULT 0,
    "distracted_count" INTEGER NOT NULL DEFAULT 0,
    "face_not_detected_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "weekly_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_stats_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "weekly_stats_counts_check" CHECK (
      "log_count" > 0
      AND "focused_count" >= 0 AND "normal_count" >= 0 AND "distracted_count" >= 0
      AND "face_not_detected_count" >= 0
      AND "focused_count" + "normal_count" + "distracted_count" = "log_count"
      AND "face_not_detected_count" <= "log_count"
    ),
    CONSTRAINT "weekly_stats_scores_check" CHECK (
      "avg_gaze_score" BETWEEN 0 AND 100 AND "avg_blink_score" BETWEEN 0 AND 100
      AND "avg_head_score" BETWEEN 0 AND 100 AND "avg_focus_score" BETWEEN 0 AND 100
    )
);

CREATE UNIQUE INDEX "hourly_stats_session_id_bucket_start_key" ON "hourly_stats"("session_id", "bucket_start");
CREATE INDEX "hourly_stats_bucket_start_idx" ON "hourly_stats"("bucket_start");
CREATE UNIQUE INDEX "daily_stats_session_id_bucket_start_key" ON "daily_stats"("session_id", "bucket_start");
CREATE INDEX "daily_stats_bucket_start_idx" ON "daily_stats"("bucket_start");
CREATE UNIQUE INDEX "weekly_stats_session_id_bucket_start_key" ON "weekly_stats"("session_id", "bucket_start");
CREATE INDEX "weekly_stats_bucket_start_idx" ON "weekly_stats"("bucket_start");
CREATE INDEX "concentration_logs_logged_at_idx" ON "concentration_logs"("logged_at");

CREATE VIEW v_session_metric_totals AS
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
