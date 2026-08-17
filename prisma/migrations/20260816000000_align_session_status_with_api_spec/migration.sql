-- 확정된 API 명세와 세션 진행 상태 이름을 일치시킨다.
ALTER TYPE "SessionStatus" RENAME VALUE 'ACTIVE' TO 'IN_PROGRESS';
