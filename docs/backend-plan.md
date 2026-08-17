# 백엔드 세부 일정 및 구현 계획

## 📌 핵심 마일스톤 요약

| 마일스톤 | 목표 | 완료 기준 | 완료 일자 |
| --- | --- | --- | --- |
| M1 | 기획 완료 | ERD 확정, API 명세 팀 합의, 개발 규칙 정의 | 7/5 |
| M2 | MVP 기능 완료 | 인증 + 세션 + 로그 저장 + 리포트 API 전체 동작 | 8/21 |
| M3 | 내부 통합 검증 | 단위 테스트 통과, 보안 점검 완료, 프론트 연동 확인 | 10/4 |
| M4 | 프로덕션 배포 완료 | AWS 라이브, CI/CD 작동, 모니터링 정상 | 10/25 |

---

## Phase 1. 상세 기획 및 설계

> 📅 6/13 ~ 7/5 (3.5주)
> ERD, API 명세, 인증 흐름 설계를 완료하고 팀 전체와 인터페이스를 합의하는 단계

- [✅]  **ERD 초안 설계** — 코어 도메인: users, sessions, concentration_logs, reports / 소셜 도메인: user_profiles, user_privacy_settings, user_connection_requests, user_connections, session_shares, session_reactions / 그룹 도메인: groups, group_members, group_invitations, group_goals, group_goal_assignees, manager_feedbacks → `docs/erd.md`, `prisma/schema.prisma`
- [✅]  **기능 명세 정리** — 로그인, 학습세션, 집중도 분석, 리포트, 온라인 네트워킹, 그룹 및 관리자 관리 → `docs/feature-spec.md`
- [✅]  **Git 브랜치 전략 정의** — main / develop / feature/xxx / hotfix/xxx, PR 1인 리뷰 규칙 → `docs/git-convention.md`
- [✅]  **API 명세서 초안 작성**
    - 인증: `POST /auth/register`, `/auth/login`, `/auth/logout`
    - 세션: `POST /sessions/start`, `/sessions/:id/log`, `/sessions/:id/end`
    - 세션: `GET /sessions`, `/sessions/:id`
    - 리포트: `GET /reports/:session_id`, `/reports/weekly`
    - 소셜: `POST /connections/request`, `PATCH /connections/:id`, `GET /connections`
    - 세션 공유: `POST /session-shares`, `GET /session-shares/feed`, `POST /session-shares/:id/reactions`
    - 랭킹: `GET /rankings` (전체 / 친구 / 그룹 필터)
    - 그룹: `POST /groups`, `GET /groups/:id`, `POST /groups/:id/invite`, `PATCH /groups/:id/members/:memberId`
    - 그룹 목표: `POST /groups/:id/goals`, `GET /groups/:id/goals`, `POST /groups/:id/goals/:goalId/assignees`
    - 관리자 피드백: `POST /groups/:id/feedbacks`, `GET /groups/:id/feedbacks`
- [✅]  **JWT 인증 흐름 설계** — Stateless 토큰 기반, 만료 시간 정의 → `docs/auth-flow.md`
- [✅]  **집중도 점수 산정 기준 협의** — `S = (Gaze × 0.4) + (Blink × 0.3) + (Head × 0.3)` 가중치 확정 → `docs/api-spec.md`, `src/utils/focusScore.js`
- [✅]  **프라이버시 설정 정책 설계** — default_session_scope (PUBLIC / FRIENDS / GROUP / PRIVATE), score_visibility, study_time_visibility, ranking_participation 옵션 정의 → `docs/api-spec.md`, `docs/feature-spec.md`, `prisma/schema.prisma`
- [✅]  **랭킹 집계 기준 협의** — 집계 대상(ranking_participation=true인 사용자), 기간(일간/주간), 지표(평균 집중도 / 총 학습시간) 확정 → `docs/api-spec.md` §7
- [✅]  **ERD 최종 확정 (팀 리뷰)**

[FocusLens_ERD_최종점검.pdf](%EB%B0%B1%EC%97%94%EB%93%9C%20%EC%84%B8%EB%B6%80%20%EC%9D%BC%EC%A0%95%20%EB%B0%8F%20%EA%B5%AC%ED%98%84%20%EA%B3%84%ED%9A%8D/FocusLens_ERD_%E1%84%8E%E1%85%AC%E1%84%8C%E1%85%A9%E1%86%BC%E1%84%8C%E1%85%A5%E1%86%B7%E1%84%80%E1%85%A5%E1%86%B7.pdf)

- [✅]  **API 명세 팀 리뷰 & 확정** — `docs/swagger.yaml` 팀 리뷰 및 인터페이스 합의 완료
- [✅]  **Roll-up 전략 설계** — 30일 초과 concentration_logs → hourly_stats 집계 후 원본 삭제 / session_reactions 등 소셜 데이터 장기 보관 정책 별도 정의 → `docs/rollup-strategy.md`
- [✅]  **보안 검증 정책 문서화** → `docs/security-policy.md`
    - ① gaze/blink/head/total: 0~100 범위 float 검증
    - ② session_id 소유자 = JWT sub 매칭
    - ③ 1분 미만 중복 전송 차단
    - ④ HTTPS 전송 강제 (배포 시)
    - ⑤ 그룹 권한 검증 — group_members.group_role 기준 (OWNER / MANAGER / MEMBER), groups.owner_id 단독 판단 금지
    - ⑥ 세션 공유 조회 — user_privacy_settings.default_session_scope 준수 여부 검증

---

## Phase 2. 환경 구축

> 📅 7/6 ~ 7/12 (1주)
> 백엔드 서버 초기 설정, Docker 환경, DB 연결을 완료하고 팀 전체가 동일한 환경 세팅

- [✅]  **Docker / docker-compose 설정**
    - 서비스 구성: backend + postgres + redis
    - `.env.example` 작성 및 팀 공유
- [✅]  **Express / FastAPI 서버 초기 세팅**
    - 최종 언어 확정: Node.js + Express **또는** Python + FastAPI
    - 디렉토리 구조: `src/routes`, `src/controllers`, `src/middleware`, `src/models`
- [✅]  **PostgreSQL 연결 & 전체 스키마 migration 실행**
    - Prisma (Node) 또는 SQLAlchemy (Python) 설정
    - 코어: users, sessions, concentration_logs, reports 테이블 생성
    - 소셜: user_profiles, user_privacy_settings, user_connection_requests, user_connections, session_shares, session_reactions 테이블 생성
    - 그룹: groups, group_members, group_invitations, group_goals, group_goal_assignees, manager_feedbacks 테이블 생성
    - ERD 확정 제약조건 적용 — UNIQUE, CHECK(score BETWEEN 0 AND 100), CHECK(user_a_id <> user_b_id) 등 → `prisma/migrations/20260815000000_add_database_check_constraints/migration.sql`
    - 시드 데이터(테스트 유저, 테스트 그룹) 스크립트 작성
- [✅]  **조회용 View 초안 생성**
    - `v_session_share_reaction_counts` — session_reactions를 session_share_id, reaction_type 기준 집계
    - `v_user_session_summaries` — sessions, concentration_logs, reports 조인 세션 요약
    - `v_group_member_stats` — 그룹 구성원별 기간별 학습 통계
    - `v_rankings` — ranking_participation=true 사용자 대상 집중도/학습시간 집계
- [✅]  **환경변수(.env) 관리 구조 설정** — 로컬 / 개발 / 프로덕션 템플릿 분리 (`backend/.env.*.example`), 실제 비밀값은 Git 제외
- [✅]  **기본 라우터 구조 생성** — 각 도메인별 라우터 파일 분리 (auth / sessions / reports / social / groups)
- [✅]  **Health check API 확인** — `GET /health` → 200 응답
- [✅]  **Git repo 구조 및 브랜치 규칙 팀 확인**

---

## Phase 3. MVP 핵심 개발

> 📅 7/13 ~ 8/21 (5.5주)

### 3-1. 인증 및 코어 기능

- [✅]  **JWT 인증 미들웨어 구현**
    - 모든 보호된 라우트에 적용
    - 유효하지 않은 토큰 → 401 응답
- [ ]  **회원가입 API** — `POST /api/auth/register`
    - bcrypt 비밀번호 해싱
    - 이메일 중복 검사
    - 가입 시 user_profiles, user_privacy_settings 기본값 자동 생성 (default_session_scope=PRIVATE, ranking_participation=false)
- [ ]  **로그인 API** — `POST /api/auth/login`
    - JWT access token 발급 (만료 1시간)
    - bcrypt 비밀번호 검증
- [ ]  **로그아웃 API** — `POST /api/auth/logout`
    - Redis 블랙리스트 또는 DB 토큰 무효화
- [✅]  **DB 스키마 구현** — 최종 확정된 ERD 기반 migration 실행
- [ ]  **세션 시작 API** — `POST /api/sessions/start`
    - Request: `{ user_id }`
    - Response: `201 + session_id`
- [ ]  **세션 종료 API** — `POST /api/sessions/:id/end`
    - avg_score는 sessions에 저장하지 않고 리포트/조회 API에서 concentration_logs로 산출
    - report 자동 생성 트리거 (summary_json에 gaze/blink/head 분리 통계 포함)
    - Response: `200 + report_id`
- [ ]  **집중도 로그 저장 API** — `POST /api/sessions/:id/log`
    - Request: `{ gaze, blink, head, total }`
    - Response: `200`
- [ ]  **보안 검증 4조건 구현**
    - ① 점수 범위 검증 (0~100 float)
    - ② session_id 소유자 검증 (JWT sub 매칭)
    - ③ 1분 미만 중복 전송 차단
    - ④ 검증 실패 시 400/403 응답 + 로그 기록
- [✅]  **분당 1회 요청 제한 로직** 구현
- [✅]  **세션 평균 집중도 계산 로직** 구현 (concentration_logs 집계 기반, sessions 컬럼 저장 없음)
- [ ]  **개별 세션 상세 조회** — `GET /api/sessions/:id`
    - 분 단위 집중도 타임라인 포함
- [ ]  **전체 세션 목록 조회** — `GET /api/sessions`
    - 사용자별 세션 리스트, 최신순 정렬
- [ ]  **세션별 집중도 리포트 조회** — `GET /api/reports/:session_id`
    - 분 단위 타임라인 + gaze/blink/head 분리 통계 + 요약
- [ ]  **주간 집중도 요약 API** — `GET /api/reports/weekly`
    - 최근 7일 일별 평균 집중도
- [ ]  **월간 집중도 API** — `GET /api/reports/monthly` (선택)

### 3-2. 소셜 네트워킹 기능

- [✅]  **프로필 조회/수정 API**
    - `GET /api/users/:id/profile` — 공개 프로필 (nickname, bio, profile_image_url)
    - `PATCH /api/users/me/profile` — 내 프로필 수정
- [ ]  **프라이버시 설정 조회/수정 API**
    - `GET /api/users/me/privacy` — 현재 공개 설정 조회
    - `PATCH /api/users/me/privacy` — 공개 범위 수정 (default_session_scope, score_visibility 등)
- [ ]  **친구 요청 API** — `POST /api/connections/request`
    - requester_user_id ≠ receiver_user_id 검증 (자기 자신 요청 차단)
    - 이미 연결된 관계 중복 요청 차단
- [ ]  **친구 요청 수락/거절 API** — `PATCH /api/connections/:id`
    - status: ACCEPTED → user_connections에 양방향 레코드 자동 생성
    - status: REJECTED → user_connection_requests 상태 업데이트만
- [ ]  **친구 목록 조회 API** — `GET /api/connections`
- [ ]  **세션 공유 API** — `POST /api/session-shares`
    - share_scope: PUBLIC / FRIENDS / GROUP 선택
    - GROUP 공유 시 group_id 필수
    - user_privacy_settings.default_session_scope 초과 공개 차단
- [ ]  **소셜 피드 조회 API** — `GET /api/session-shares/feed`
    - 친구 공개 세션 + 전체 공개 세션 통합 조회
    - v_session_share_reaction_counts View를 통해 공감 개수 포함
    - 조회 대상 세션 소유자의 score_visibility / study_time_visibility 준수
- [ ]  **공감 반응 API** — `POST /api/session-shares/:id/reactions`
    - reaction_type: LIKE / CHEER / EMPATHY
    - UNIQUE(session_share_id, user_id, reaction_type) 중복 반응 차단
- [✅]  **공감 반응 취소 API** — `DELETE /api/session-shares/:id/reactions/:reactionType`
- [ ]  **랭킹 조회 API** — `GET /api/rankings`
    - 쿼리 파라미터: `scope` (global / friends / group), `period` (daily / weekly), `metric` (focus_score / study_time)
    - ranking_participation=false 사용자 제외
    - v_rankings View 기반 집계

### 3-3. 그룹 및 관리자 기능

- [ ]  **그룹 생성 API** — `POST /api/groups`
    - 생성자는 group_members에 group_role=OWNER로 자동 등록
    - groups.created_by_user_id 설정 (이력 보존용, 권한은 group_members 기준)
- [ ]  **그룹 상세 조회 API** — `GET /api/groups/:id`
    - visibility 기준 접근 제어 (PUBLIC / PRIVATE)
- [ ]  **그룹 목록 조회 API** — `GET /api/groups`
    - 내가 속한 그룹 목록
- [ ]  **그룹 초대 API** — `POST /api/groups/:id/invite`
    - group_role=OWNER 또는 MANAGER만 초대 가능
    - invite_code 생성, invitee_email 또는 invitee_user_id 지정
    - expires_at 설정 (기본 7일)
- [ ]  **초대 코드로 그룹 참여 API** — `POST /api/groups/join`
    - invite_code 유효성 및 만료 검증
    - 참여 시 group_members에 group_role=MEMBER로 등록
- [ ]  **그룹 멤버 권한 변경 API** — `PATCH /api/groups/:id/members/:memberId`
    - OWNER만 group_role 변경 가능
- [ ]  **그룹 멤버 내보내기 API** — `DELETE /api/groups/:id/members/:memberId`
    - OWNER / MANAGER만 실행 가능, OWNER 본인 내보내기 불가
- [ ]  **그룹 대시보드 조회 API** — `GET /api/groups/:id/dashboard`
    - v_group_member_stats View 기반 구성원별 학습 통계
    - OWNER / MANAGER만 전체 구성원 데이터 조회, MEMBER는 자신 데이터만 조회
- [ ]  **그룹 목표 생성 API** — `POST /api/groups/:id/goals`
    - OWNER / MANAGER만 생성 가능
    - target_study_minutes, target_focus_score, start_date, end_date 설정
- [ ]  **그룹 목표 목록 조회 API** — `GET /api/groups/:id/goals`
- [ ]  **그룹 목표 배정 API** — `POST /api/groups/:id/goals/:goalId/assignees`
    - group_goal_assignees에 group_member_id 등록
    - 전체 구성원 대상(목표 배정 없음)과 특정 멤버 배정 구분
- [ ]  **관리자 피드백 작성 API** — `POST /api/groups/:id/feedbacks`
    - manager_member_id: JWT sub 기준 group_members 조회 (group_role=OWNER 또는 MANAGER 검증)
    - target_member_id, session_id(선택), content 저장
- [ ]  **관리자 피드백 조회 API** — `GET /api/groups/:id/feedbacks`
    - OWNER / MANAGER: 전체 피드백 조회
    - MEMBER: 자신이 받은 피드백만 조회

### 3-4. 공통

- [✅]  **전역 예외 처리 미들웨어** — 400 / 403 / 404 / 500 응답 표준화
- [ ]  **Swagger 문서 정리** — 전체 API 엔드포인트 명세 완성
- [✅]  **프론트엔드 팀 API 연동 지원** — CORS 설정, 응답 포맷 통일

---

## Phase 4. 테스트 및 고도화

> 📅 8/31 ~ 10/4 (5주)
> 단위 테스트 작성, 보안 점검, Roll-up 스케줄러 구현, 통합 테스트 진행

- [ ]  **인증 모듈 단위 테스트**
    - 정상 로그인, 잘못된 토큰, 만료 토큰 케이스
- [ ]  **세션 API 테스트**
    - 세션 시작/종료 정상 흐름
    - 보안 검증 4조건 각각 테스트
- [ ]  **리포트 API 테스트**
    - 빈 세션, 정상 데이터, 날짜 필터 엣지케이스
- [ ]  **소셜 기능 단위 테스트**
    - 친구 요청 정상 흐름, 중복 요청 차단, 자기 자신 요청 차단
    - 세션 공유: default_session_scope 초과 공개 차단 케이스
    - 공감 반응 중복 차단 (UNIQUE 제약 검증)
    - 랭킹 조회: ranking_participation=false 사용자 제외 확인
- [ ]  **그룹 기능 단위 테스트**
    - 그룹 생성 시 OWNER 자동 등록 확인
    - 권한 검증: MEMBER가 초대/권한 변경/피드백 작성 시도 시 403 응답
    - 초대 코드 만료 후 참여 시도 차단
    - 대시보드 조회: MEMBER가 타인 데이터 조회 시도 시 403 응답
    - 피드백 조회: MEMBER가 자신 대상 피드백만 수신 확인
- [ ]  **Roll-up 스케줄러 구현**
    - 매일 자정 실행 (cron)
    - 30일 초과 concentration_logs → hourly_stats 집계 후 원본 삭제
    - 단계별 추가 압축: hourly → daily → weekly
- [ ]  **스케줄러 동작 테스트** — 수동 트리거로 집계 결과 검증
- [ ]  **보안 점검**
    - SQL Injection, XSS 취약점 점검
    - 네트워크 오류 / 권한 오류 예외 처리 보완
    - 그룹 권한 우회 시나리오 점검 (group_members 기준 검증 일관성 확인)
    - 세션 공유 프라이버시 설정 우회 시나리오 점검
- [ ]  **쿼리 성능 분석**
    - `EXPLAIN ANALYZE`로 N+1 쿼리 확인
    - concentration_logs: `(session_id, logged_at)` 복합 인덱스 추가
    - sessions: `(user_id, started_at)` 인덱스 추가
    - session_shares: `(session_id, share_scope, group_id)` 부분 UNIQUE 인덱스 추가
    - session_reactions: `(session_share_id, user_id, reaction_type)` UNIQUE 인덱스 확인
    - group_members: `(group_id, user_id)` UNIQUE 인덱스 확인
    - v_rankings Materialized View 전환 검토 — 랭킹 조회 빈도 높을 경우 적용
- [ ]  **View 성능 검증** — v_session_share_reaction_counts, v_user_session_summaries, v_group_member_stats, v_rankings 각 실행 계획 확인
- [ ]  **프론트엔드 통합 테스트 지원**
    - 실제 프론트 연동 흐름 E2E 검증
- [ ]  **통합 버그 수정**
- [ ]  **데이터 최적화** — 주간/월간 집계 쿼리 성능 재검증
- [ ]  **API 문서 최종 업데이트** — Swagger 최종본

---

## Phase 5. 배포 및 안정화

> 📅 10/5 ~ 10/25 (3주)
> AWS 인프라 구성, CI/CD 파이프라인 설정, 라이브 환경 검증 및 최종 발표 준비를 진행합니다.

- [ ]  **AWS EC2 서버 구성**
    - 인스턴스: t3.micro (프리티어)
    - Node: PM2 프로세스 관리 / Python: gunicorn + nginx
- [ ]  **AWS RDS PostgreSQL 셋업**
    - 인스턴스: db.t3.micro
    - 자동 백업 활성화
    - 보안그룹: EC2 → RDS 내부 통신만 허용 (퍼블릭 DB 차단)
- [ ]  **AWS S3 버킷 설정** — 리포트 파일 및 정적 에셋 저장
- [ ]  **GitHub Actions CI/CD 파이프라인 구성**
    - main 브랜치 push → 자동 테스트 → EC2 SSH 배포
    - Secrets: GitHub Actions Secrets으로 환경변수 관리
- [ ]  **프로덕션 환경변수 설정** — DB_URL, JWT_SECRET, REDIS_URL 등
- [ ]  **라이브 서버 API 동작 확인** — `GET /health` 및 주요 API 엔드포인트 검증
- [ ]  **프론트엔드 팀과 배포 환경 연동 확인**
- [ ]  **성능 모니터링 설정**
    - AWS CloudWatch: CPU, 메모리, 요청 수 기본 모니터링
    - 헬스체크 엔드포인트 주기적 확인 설정
- [ ]  **최종 버그 수정**
- [ ]  **최종 보안 점검** — HTTPS 강제 적용, 민감 정보 노출 여부 확인
- [ ]  **문서 정리 및 발표 자료 준비**
    - API 명세 최종본 (Swagger)
    - 아키텍처 다이어그램
    - 기술 스택 및 구현 내용 정리

---

## 📎 참고: 기술 스택 확정 체크리스트

> Phase 1 시작 전 팀 미팅에서 확정 필요

- [ ]  백엔드 언어: **Node.js (Express)** vs **Python (FastAPI)**
- [ ]  ORM: **Prisma** (Node) vs **SQLAlchemy** (Python)
- [ ]  데이터베이스 호스팅: **Supabase** (빠른 셋업) vs **AWS RDS** (확장성)
- [ ]  AI 추론 위치: **Client-side (MediaPipe.js)** vs **Server-side (FastAPI)**
- [ ]  레포 구조: **모노레포** vs **멀티레포**

---

## 📎 참고: API 보안 검증 정책

POST `/api/sessions/:id/log` 수신 시 아래 조건을 반드시 검증합니다.
검증 실패 시 400/403 응답과 로그 기록을 반환합니다.

| 번호 | 검증 항목 | 실패 응답 |
| --- | --- | --- |
| ① | gaze/blink/head/total: 0~100 범위 float | 400 |
| ② | session_id 소유자 = JWT sub 매칭 | 403 |
| ③ | 1분 미만 중복 전송 차단 | 400 |
| ④ | HTTPS 전송 여부 (배포 시 강제) | — |
| ⑤ | 그룹 권한: group_members.group_role 기준 (groups.created_by_user_id 단독 판단 금지) | 403 |
| ⑥ | 세션 공유 조회: user_privacy_settings.default_session_scope 초과 공개 차단 | 403 |

---

## 📎 참고: 집중도 점수 산정 알고리즘

```
S = (Gaze × 0.4) + (Blink × 0.3) + (Head × 0.3)
```

| 점수 구간 | 상태 |
| --- | --- |
| S ≥ 70 | 집중 상태 ✅ |
| 40 ≤ S < 70 | 보통 🟡 |
| S < 40 | 집중 이탈 경고 🔴 |

- **Gaze 점수**: 측정 구간 내 화면 응시 비율 × 100
- **Blink 점수**: 정상 깜빡임 범위 내 비율 기반 (너무 많거나 적으면 감점)
- **Head 점수**: 측정 구간 내 정면 자세 유지 비율 × 100

---

## 📎 참고: 조회용 View 목록

파생 데이터(공감 개수, 랭킹, 기간별 평균 등)는 기본 테이블에 저장하지 않고 아래 View로 산출합니다. 랭킹 조회 빈도가 높을 경우 v_rankings는 Materialized View 전환을 검토합니다.

| View 이름 | 집계 기준 | 사용 목적 |
| --- | --- | --- |
| v_session_share_reaction_counts | session_reactions를 session_share_id, reaction_type 기준 집계 | 피드에서 좋아요/응원/공감 개수 표시 |
| v_user_session_summaries | sessions, concentration_logs, reports 조인 | 내 기록/공개 피드의 세션 카드 표시 |
| v_group_member_stats | group_members와 세션 기록을 기간별 집계 | 관리자 그룹 대시보드 |
| v_rankings | ranking_participation=true 사용자의 세션만 집계 | 전체/친구/그룹 랭킹 |
