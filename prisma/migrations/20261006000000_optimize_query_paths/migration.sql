-- Phase 4-5: indexes for bounded list APIs and report/social/group query paths.

CREATE INDEX "sessions_user_id_status_started_at_id_idx"
  ON "sessions"("user_id", "status", "started_at" DESC, "id" DESC);

CREATE INDEX "sessions_completed_started_at_user_id_idx"
  ON "sessions"("started_at" DESC, "user_id")
  WHERE "status" = 'COMPLETED' AND "ended_at" IS NOT NULL;

CREATE INDEX "sessions_completed_activity_date_user_id_idx"
  ON "sessions"(("started_at"::DATE), "user_id")
  WHERE "status" = 'COMPLETED' AND "ended_at" IS NOT NULL;

CREATE INDEX "session_shares_active_created_at_id_idx"
  ON "session_shares"("created_at" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;

CREATE INDEX "session_shares_active_scope_group_created_id_idx"
  ON "session_shares"("share_scope", "group_id", "created_at" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;

CREATE INDEX "user_connection_requests_receiver_status_created_id_idx"
  ON "user_connection_requests"("receiver_user_id", "status", "created_at" DESC, "id" DESC);

CREATE INDEX "user_connection_requests_requester_status_created_id_idx"
  ON "user_connection_requests"("requester_user_id", "status", "created_at" DESC, "id" DESC);

CREATE INDEX "user_connections_user_a_created_id_idx"
  ON "user_connections"("user_a_id", "created_at" DESC, "id" DESC);

CREATE INDEX "user_connections_user_b_created_id_idx"
  ON "user_connections"("user_b_id", "created_at" DESC, "id" DESC);

CREATE INDEX "group_members_user_status_joined_id_idx"
  ON "group_members"("user_id", "status", "joined_at" DESC, "id" DESC);

CREATE INDEX "group_members_group_status_role_joined_id_idx"
  ON "group_members"("group_id", "status", "group_role", "joined_at", "id");

CREATE INDEX "group_goals_group_status_created_id_idx"
  ON "group_goals"("group_id", "status", "created_at" DESC, "id" DESC);

CREATE INDEX "manager_feedbacks_group_target_created_id_idx"
  ON "manager_feedbacks"("group_id", "target_member_id", "created_at" DESC, "id" DESC);

CREATE INDEX "manager_feedbacks_group_created_id_idx"
  ON "manager_feedbacks"("group_id", "created_at" DESC, "id" DESC);
