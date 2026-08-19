-- 동시에 여러 세션 시작 요청이 들어와도 사용자별 진행 중 세션은 하나만 허용한다.
-- Prisma schema가 부분 인덱스를 표현하지 못하므로 raw migration으로 관리한다.
CREATE UNIQUE INDEX "sessions_one_in_progress_per_user_key"
    ON "sessions" ("user_id")
    WHERE "status" = 'IN_PROGRESS';
