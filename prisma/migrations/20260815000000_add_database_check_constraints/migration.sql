-- Phase 2 ERD constraints that Prisma cannot express in schema.prisma.
-- Keep these checks in the database as a final safety boundary even though
-- request validation is also performed by the Express application.

ALTER TABLE "concentration_logs"
    ADD CONSTRAINT "concentration_logs_gaze_score_range_check"
        CHECK ("gaze_score" BETWEEN 0 AND 100),
    ADD CONSTRAINT "concentration_logs_blink_score_range_check"
        CHECK ("blink_score" BETWEEN 0 AND 100),
    ADD CONSTRAINT "concentration_logs_head_score_range_check"
        CHECK ("head_score" BETWEEN 0 AND 100),
    ADD CONSTRAINT "concentration_logs_focus_score_range_check"
        CHECK ("focus_score" BETWEEN 0 AND 100);

ALTER TABLE "group_goals"
    ADD CONSTRAINT "group_goals_target_focus_score_range_check"
        CHECK ("target_focus_score" IS NULL OR "target_focus_score" BETWEEN 0 AND 100);

ALTER TABLE "user_connection_requests"
    ADD CONSTRAINT "user_connection_requests_distinct_users_check"
        CHECK ("requester_user_id" <> "receiver_user_id");

ALTER TABLE "user_connections"
    ADD CONSTRAINT "user_connections_distinct_users_check"
        CHECK ("user_a_id" <> "user_b_id");
