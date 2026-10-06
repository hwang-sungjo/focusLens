-- 기존 로그는 세션별 수신 순서로 1부터 번호를 부여한다.
-- 새 로그의 minute_index는 백엔드가 sessions.started_at과 수신 시각으로 계산한다.
ALTER TABLE "concentration_logs" ADD COLUMN "minute_index" INTEGER;

WITH numbered_logs AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "session_id"
      ORDER BY "logged_at" ASC, "id" ASC
    )::INTEGER AS "minute_index"
  FROM "concentration_logs"
)
UPDATE "concentration_logs" AS target
SET "minute_index" = numbered_logs."minute_index"
FROM numbered_logs
WHERE target."id" = numbered_logs."id";

ALTER TABLE "concentration_logs"
  ALTER COLUMN "minute_index" SET NOT NULL,
  ADD CONSTRAINT "concentration_logs_minute_index_check" CHECK ("minute_index" >= 1);

DROP INDEX "concentration_logs_session_id_logged_at_key";

CREATE UNIQUE INDEX "concentration_logs_session_id_minute_index_key"
  ON "concentration_logs"("session_id", "minute_index");
