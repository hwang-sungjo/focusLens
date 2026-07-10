# FocusLens 기능 명세서

> **기준 문서**: `docs/erd.md`, `docs/api-spec.md`  
> **응답 형식**: `{ success, data, error }`  
> **권한 원칙**: 그룹 API는 `group_members.group_role` 기준, 세션 API는 JWT `sub` = `sessions.user_id`

---

## 1. 인증 (Auth)

### 1.1 회원가입

| 항목 | 내용 |
| --- | --- |
| **기능명** | 회원가입 |
| **행위 주체** | 미인증 사용자 (신규 가입자) |
| **사전 조건** | 유효한 이메일·비밀번호(8자 이상)·이름·닉네임 입력. 동일 이메일·닉네임 미등록 상태 |
| **처리 흐름** | 1. `POST /api/auth/register` 요청 수신<br>2. 이메일·닉네임 중복 검사 (`users.email`, `user_profiles.nickname` UNIQUE)<br>3. `bcrypt`로 `password_hash` 생성 후 `users` INSERT (`status=ACTIVE`)<br>4. `user_profiles` INSERT (nickname, bio 등)<br>5. `user_privacy_settings` INSERT (`default_session_scope=PRIVATE`, `ranking_participation=false`)<br>6. JWT Access Token 발급 (`sub=user_id`, 만료 1시간)<br>7. `201` + `user_id`, `access_token`, `expires_in` 반환 |
| **예외 처리** | 필수 필드 누락 → **400**<br>비밀번호 8자 미만 → **400**<br>이메일 중복 → **409**<br>닉네임 중복 → **409**<br>DB 오류 → **500** + 로그 기록 |

---

### 1.2 로그인

| 항목 | 내용 |
| --- | --- |
| **기능명** | 로그인 |
| **행위 주체** | 기존 회원 (미인증 상태) |
| **사전 조건** | `users`에 등록된 이메일. `users.deleted_at IS NULL` |
| **처리 흐름** | 1. `POST /api/auth/login` — `email`, `password` 수신<br>2. `users`에서 이메일로 조회<br>3. `bcrypt.compare`로 비밀번호 검증<br>4. `users.status = ACTIVE` 확인<br>5. JWT Access Token 발급 (`sub`, `email`, `role`, `exp` = 1시간)<br>6. `200` + `user_id`, `access_token`, `expires_in` 반환 |
| **예외 처리** | 필수 필드 누락 → **400**<br>이메일·비밀번호 불일치 → **401** (구분 메시지 노출 최소화)<br>`status ≠ ACTIVE` → **403** `"비활성화된 계정입니다"`<br>DB 오류 → **500** |

---

### 1.3 로그아웃

| 항목 | 내용 |
| --- | --- |
| **기능명** | 로그아웃 |
| **행위 주체** | 인증된 사용자 |
| **사전 조건** | 유효한 JWT Access Token (`Authorization: Bearer`) |
| **처리 흐름** | 1. `POST /api/auth/logout` — JWT 미들웨어 검증<br>2. 토큰 해시로 Redis 키 `blacklist:{sha256(token)}` 생성<br>3. TTL = JWT `exp`까지 남은 초로 SET<br>4. `200` + `"로그아웃되었습니다"` 반환<br>5. 이후 동일 토큰 요청 시 미들웨어에서 **401** |
| **예외 처리** | 토큰 없음 → **401**<br>만료·무효 토큰 → **401**<br>Redis 장애 → **500** (토큰 무효화 실패 로그) |

---

## 2. 학습 세션 (Sessions)

> ERD: `sessions`에 `avg_focus_score`, `duration_seconds` 저장 금지 — 조회·리포트 시 `concentration_logs`에서 계산

### 2.1 세션 시작

| 항목 | 내용 |
| --- | --- |
| **기능명** | 학습 세션 시작 |
| **행위 주체** | 인증된 사용자 |
| **사전 조건** | JWT 유효. 동일 사용자의 `IN_PROGRESS` 세션이 없음 (정책에 따라 1개 제한) |
| **처리 흐름** | 1. `POST /api/sessions/start` — JWT `sub`에서 `user_id` 추출<br>2. `sessions` INSERT (`user_id`, `started_at=NOW()`, `status=IN_PROGRESS`)<br>3. `201` + `session_id`, `started_at`, `status` 반환 |
| **예외 처리** | JWT 없음/만료 → **401**<br>이미 진행 중인 세션 존재 → **409**<br>DB 오류 → **500** |

---

### 2.2 집중도 로그 저장

| 항목 | 내용 |
| --- | --- |
| **기능명** | 분 단위 집중도 로그 저장 |
| **행위 주체** | 세션 소유자 (인증된 사용자) |
| **사전 조건** | JWT 유효. `sessions.id = :id` 존재. `sessions.user_id = JWT sub`. `sessions.status = IN_PROGRESS` |
| **처리 흐름** | 1. `POST /api/sessions/:id/log` — `{ gaze, blink, head, total }` 수신<br>2. 미들웨어: 각 점수 0~100 float 검증 (`focusScore.js`)<br>3. 미들웨어: `sessions.user_id = sub` 소유자 검증<br>4. `logged_at = date_trunc('minute', NOW())` 정규화<br>5. 동일 `(session_id, logged_at)` 존재 여부 확인 (UNIQUE 사전 검사)<br>6. `focus_score = total`, `attention_state` = S 기준 판별 (≥70 FOCUSED, 40~69 NORMAL, <40 DISTRACTED)<br>7. `concentration_logs` INSERT<br>8. `200` + `log_id`, `logged_at`, `focus_score`, `attention_state` 반환 |
| **예외 처리** | 점수 범위 위반 → **400**<br>동일 분 중복 → **400** `"1분 미만 중복 로그 전송입니다"`<br>JWT 없음 → **401**<br>소유자 불일치 → **403**<br>세션 없음 → **404**<br>종료된 세션 → **409**<br>UNIQUE DB 충돌 (동시 요청) → **400** |

---

### 2.3 세션 종료

| 항목 | 내용 |
| --- | --- |
| **기능명** | 학습 세션 종료 및 리포트 생성 |
| **행위 주체** | 세션 소유자 |
| **사전 조건** | JWT 유효. `sessions.status = IN_PROGRESS`. `sessions.user_id = JWT sub` |
| **처리 흐름** | 1. `POST /api/sessions/:id/end` 요청<br>2. 소유자 검증 후 `sessions` UPDATE (`ended_at=NOW()`, `status=COMPLETED`)<br>3. `concentration_logs` 집계 → gaze/blink/head/focus 평균, duration(`ended_at-started_at`), 상태별 분 수<br>4. `reports` INSERT (`session_id` UNIQUE, `summary_json`에 통계 저장)<br>5. `200` + `session_id`, `report_id`, `summary` 반환 |
| **예외 처리** | JWT 없음 → **401**<br>소유자 불일치 → **403**<br>세션 없음 → **404**<br>이미 종료 → **409**<br>리포트 생성 실패 → **500** (세션 상태 롤백) |

---

## 3. 리포트 (Reports)

### 3.1 세션 리포트 조회

| 항목 | 내용 |
| --- | --- |
| **기능명** | 세션별 집중도 리포트 조회 |
| **행위 주체** | 세션 소유자 |
| **사전 조건** | JWT 유효. `sessions.status = COMPLETED`. `reports` 레코드 존재. `sessions.user_id = JWT sub` |
| **처리 흐름** | 1. `GET /api/reports/:session_id` 요청<br>2. `sessions` + `reports` JOIN, 소유자 검증<br>3. `reports.summary_json` 반환<br>4. `concentration_logs` 타임라인 조회 (분 단위 gaze/blink/head/focus, `attention_state`)<br>5. `200` + `report_id`, `summary_json`, `timeline`, `created_at` |
| **예외 처리** | JWT 없음 → **401**<br>소유자 불일치 → **403**<br>세션 없음 → **404**<br>리포트 미생성(미종료 세션) → **404** `"리포트가 아직 생성되지 않았습니다"` |

---

### 3.2 주간 집중도 요약

| 항목 | 내용 |
| --- | --- |
| **기능명** | 주간 집중도 요약 조회 |
| **행위 주체** | 인증된 사용자 (본인 데이터) |
| **사전 조건** | JWT 유효 |
| **처리 흐름** | 1. `GET /api/reports/weekly` — 선택 `end_date` (기본 오늘)<br>2. 기준일 포함 최근 7일 범위 산출<br>3. JWT `sub` 사용자의 `COMPLETED` 세션 + `concentration_logs` 집계<br>4. 일별 `session_count`, `total_study_seconds`, `avg_focus_score` 계산<br>5. 주간 평균 집중도·총 학습 시간 합산<br>6. `200` + `period`, `daily_summaries`, `weekly_avg_focus_score`, `weekly_total_study_seconds` |
| **예외 처리** | JWT 없음 → **401**<br>`end_date` 형식 오류 → **400**<br>해당 기간 세션 없음 → **200** (빈 `daily_summaries`, 0 값) |

---

## 4. 소셜 (Social)

### 4.1 친구 요청

| 항목 | 내용 |
| --- | --- |
| **기능명** | 친구 연결 요청 전송 |
| **행위 주체** | 인증된 사용자 (요청자) |
| **사전 조건** | JWT 유효. `receiver_user_id ≠ JWT sub`. 수신자 `users` 존재. 기존 `user_connections` 없음. 동일 쌍 `PENDING` 요청 없음 |
| **처리 흐름** | 1. `POST /api/connections/request` — `receiver_user_id` 수신<br>2. `requester_user_id = JWT sub` 설정<br>3. 자기 자신 요청·중복 친구·대기 요청 검증<br>4. `user_connection_requests` INSERT (`status=PENDING`)<br>5. `201` + `request_id`, 양쪽 user_id, `status`, `created_at` |
| **예외 처리** | `receiver_user_id` 누락 → **400**<br>자기 자신 요청 → **400**<br>JWT 없음 → **401**<br>수신자 없음 → **404**<br>이미 친구 → **409**<br>대기 중 요청 존재 → **409** |

---

### 4.2 친구 요청 수락 / 거절

| 항목 | 내용 |
| --- | --- |
| **기능명** | 친구 요청 수락·거절·취소 |
| **행위 주체** | 수신자(수락/거절) 또는 요청자(취소) |
| **사전 조건** | JWT 유휴. `user_connection_requests.status = PENDING`. 처리 권한: 수락/거절 → `receiver_user_id = sub`, 취소 → `requester_user_id = sub` |
| **처리 흐름** | 1. `PATCH /api/connections/:id` — `{ status }` 수신<br>2. 요청 레코드 조회 및 권한·상태 검증<br>3. `ACCEPTED`: `user_connection_requests` UPDATE + `user_connections` INSERT (`user_a_id`, `user_b_id` 정렬)<br>4. `REJECTED` / `CANCELLED`: 요청 상태 UPDATE만<br>5. `200` + `request_id`, `status`, `connection_id`(수락 시) |
| **예외 처리** | 잘못된 status → **400**<br>JWT 없음 → **401**<br>권한 없음 → **403**<br>요청 없음 → **404**<br>이미 처리됨 → **409** |

---

### 4.3 소셜 피드 조회

| 항목 | 내용 |
| --- | --- |
| **기능명** | 세션 공유 피드 조회 |
| **행위 주체** | 인증된 사용자 (조회자) |
| **사전 조건** | JWT 유효 |
| **처리 흐름** | 1. `GET /api/session-shares/feed` — `page`, `limit`, `scope` (all/friends/public)<br>2. `session_shares` WHERE `deleted_at IS NULL`, `status=ACTIVE`<br>3. 조회자 접근 가능 scope 필터: PUBLIC 전체 / FRIENDS는 `user_connections` / GROUP은 공통 `group_members`<br>4. 세션 소유자 `user_privacy_settings.default_session_scope` 이하 share만 노출<br>5. `score_visibility`, `study_time_visibility`에 따라 `session_summary` 마스킹<br>6. `v_session_share_reaction_counts`로 공감 수 집계<br>7. `200` + `feed[]`, `pagination` |
| **예외 처리** | JWT 없음 → **401**<br>잘못된 scope → **400**<br>결과 없음 → **200** (빈 feed) |

---

### 4.4 공감 반응

| 항목 | 내용 |
| --- | --- |
| **기능명** | 공유 세션 공감 반응 추가 |
| **행위 주체** | 인증된 사용자 (피드 접근 가능한 조회자) |
| **사전 조건** | JWT 유효. `session_shares` ACTIVE·미삭제. 조회자가 해당 share 접근 가능. 동일 `(session_share_id, user_id, reaction_type)` 없음 |
| **처리 흐름** | 1. `POST /api/session-shares/:id/reactions` — `{ reaction_type: LIKE\|CHEER\|EMPATHY }`<br>2. share 존재·접근 권한 확인<br>3. `session_reactions` INSERT<br>4. `201` + `reaction_id`, `session_share_id`, `reaction_type`, `created_at` |
| **예외 처리** | 잘못된 reaction_type → **400**<br>JWT 없음 → **401**<br>접근 불가 share → **403**<br>share 없음 → **404**<br>중복 반응 → **409** (UNIQUE 제약) |

---

### 4.5 랭킹 조회

| 항목 | 내용 |
| --- | --- |
| **기능명** | 집중도·학습 시간 랭킹 조회 |
| **행위 주체** | 인증된 사용자 |
| **사전 조건** | JWT 유효. `scope`, `period`, `metric` 필수. `scope=group` 시 `group_id` + `group_members` ACTIVE |
| **처리 흐름** | 1. `GET /api/rankings?scope&period&metric&group_id`<br>2. `v_rankings` View 조회 — `ranking_participation=true` 사용자만 포함<br>3. scope 필터: global / friends(`user_connections`) / group(`group_members`)<br>4. period: daily / weekly, metric: focus_score / study_time<br>5. 순위·값·session_count 산출, 요청자 `my_rank` 포함<br>6. `200` + `rankings[]`, `my_rank` |
| **예외 처리** | 필수 파라미터 누락 → **400**<br>JWT 없음 → **401**<br>group scope 비구성원 → **403**<br>group 없음 → **404** |

---

## 5. 세션 공유 (Session Shares)

> ERD: `session_shares.user_id` 없음 — 소유자는 `session_id → sessions.user_id`

### 5.1 세션 공유 생성

| 항목 | 내용 |
| --- | --- |
| **기능명** | 학습 세션 공유(피드 게시) |
| **행위 주체** | 세션 소유자 |
| **사전 조건** | JWT 유효. `sessions.user_id = sub`. `sessions.status = COMPLETED`. 동일 `(session_id, share_scope, group_id)` 중복 없음 |
| **처리 흐름** | 1. `POST /api/session-shares` — `session_id`, `share_scope`, `group_id`, `share_message`<br>2. 세션 소유자 검증<br>3. **공개 범위 제어** (5.2) — `share_scope` ≤ `default_session_scope`<br>4. `share_scope=GROUP` → `group_id` 필수 + 요청자 `group_members` ACTIVE 확인<br>5. `session_shares` INSERT (`status=ACTIVE`)<br>6. `201` + `share_id`, scope, `created_at` |
| **예외 처리** | 필수 필드 누락 → **400**<br>GROUP scope에 group_id 없음 → **400**<br>JWT 없음 → **401**<br>세션 소유자 아님 → **403**<br>프라이버시 초과 공개 → **403**<br>그룹 비구성원 → **403**<br>세션 없음 → **404**<br>동일 scope 중복 → **409**<br>진행 중 세션 공유 → **409** |

---

### 5.2 공개 범위 제어 (privacy_settings 연동)

| 항목 | 내용 |
| --- | --- |
| **기능명** | 프라이버시 설정 기반 공개 범위 제한 |
| **행위 주체** | 시스템 (공유 생성·피드 조회 시 자동 적용) |
| **사전 조건** | 세션 소유자의 `user_privacy_settings` 레코드 존재 (회원가입 시 생성) |
| **처리 흐름** | **공유 생성 시**<br>1. 소유자 `default_session_scope` 조회<br>2. scope 순위 비교: `PRIVATE(0) < FRIENDS(1) < GROUP(2) < PUBLIC(3)`<br>3. `share_scope` 순위 > `default_session_scope` → 거부<br>4. `PRIVATE` 사용자 → 외부 공유 전면 차단<br><br>**피드 조회 시**<br>5. share 소유자의 `default_session_scope` JOIN<br>6. scope 초과 share는 결과에서 제외 (설정 변경 후 기존 share 무효화)<br>7. `score_visibility`, `study_time_visibility`로 노출 필드 마스킹 |
| **예외 처리** | 공유 생성 scope 초과 → **403** `"프라이버시 설정(default_session_scope)보다 넓은 범위로 공유할 수 없습니다"`<br>프라이버시 설정 없음(데이터 이상) → **500** + 관리자 알림 |

---

## 6. 그룹 (Groups)

> 권한: `group_members.group_role` (`OWNER` / `MANAGER` / `MEMBER`). `groups.created_by_user_id` 단독 판단 **금지**

### 6.1 그룹 생성

| 항목 | 내용 |
| --- | --- |
| **기능명** | 학습 그룹 생성 |
| **행위 주체** | 인증된 사용자 |
| **사전 조건** | JWT 유효 |
| **처리 흐름** | 1. `POST /api/groups` — `name`, `description`, `group_type`, `visibility`<br>2. 트랜잭션: `groups` INSERT (`created_by_user_id=sub` — 이력용)<br>3. `group_members` INSERT (`user_id=sub`, `group_role=OWNER`, `status=ACTIVE`)<br>4. `201` + `group_id`, `my_role=OWNER` |
| **예외 처리** | name 누락 → **400**<br>JWT 없음 → **401**<br>DB 오류 → **500** |

---

### 6.2 그룹 참여 (초대 코드)

| 항목 | 내용 |
| --- | --- |
| **기능명** | 초대 코드로 그룹 참여 |
| **행위 주체** | 초대받은 사용자 (인증됨) |
| **사전 조건** | JWT 유효. `group_invitations.invite_code` 유효. `status=PENDING`, `expires_at > NOW()`. 미가입 상태 (`group_members` 없음) |
| **처리 흐름** | 1. OWNER/MANAGER가 `POST /api/groups/:id/invite`로 초대 생성 (`invite_code`, `expires_at` 기본 7일)<br>2. 참여자 `POST /api/groups/join` — `{ invite_code }`<br>3. `group_invitations` 조회 — 만료·상태 검증<br>4. `invitee_user_id` 또는 `invitee_email`과 JWT 사용자 일치 확인<br>5. `group_members` INSERT (`group_role=MEMBER`, `status=ACTIVE`)<br>6. `group_invitations.status = ACCEPTED` UPDATE<br>7. `200` + `group_id`, `group_role=MEMBER` |
| **예외 처리** | invite_code 없음/만료 → **400** / **404**<br>JWT 없음 → **401**<br>초대 대상 불일치 → **403**<br>이미 구성원 → **409**<br>초대 생성 시 MEMBER가 invite 시도 → **403** (OWNER/MANAGER만) |

---

### 6.3 그룹 목표 설정

| 항목 | 내용 |
| --- | --- |
| **기능명** | 그룹 학습 목표 생성 |
| **행위 주체** | 그룹 OWNER 또는 MANAGER |
| **사전 조건** | JWT 유효. `group_members.group_role IN (OWNER, MANAGER)`, `status=ACTIVE` |
| **처리 흐름** | 1. `POST /api/groups/:id/goals` — `title`, `description`, `target_study_minutes`, `target_focus_score`, `start_date`, `end_date`<br>2. `groupAuth` 미들웨어로 역할 검증<br>3. `target_focus_score` 0~100 검증 (있을 경우)<br>4. `group_goals` INSERT (`created_by_member_id` = 요청자 `group_members.id`)<br>5. `201` + `goal_id`, 목표 상세 |
| **예외 처리** | 필수 필드 누락 → **400**<br>target_focus_score 범위 위반 → **400**<br>end_date < start_date → **400**<br>JWT 없음 → **401**<br>MEMBER 또는 비구성원 → **403**<br>그룹 없음 → **404** |

---

### 6.4 그룹 목표 배정

| 항목 | 내용 |
| --- | --- |
| **기능명** | 그룹 목표를 특정 멤버에게 배정 |
| **행위 주체** | 그룹 OWNER 또는 MANAGER |
| **사전 조건** | JWT 유효. `group_role IN (OWNER, MANAGER)`. 대상 `group_goals`가 동일 `group_id` 소속 |
| **처리 흐름** | 1. `POST /api/groups/:id/goals/:goalId/assignees` — `{ group_member_ids[] }`<br>2. 역할 검증<br>3. `group_member_ids` 각각 동일 그룹 소속 확인<br>4. 빈 배열 또는 생략 → **전체 구성원 대상** (`group_goal_assignees` 없음)<br>5. 지정 시 `group_goal_assignees` INSERT (`group_goal_id`, `group_member_id`)<br>6. `201` + `assignees[]`, `is_group_wide` |
| **예외 처리** | 유효하지 않은 member_id → **400**<br>JWT 없음 → **401**<br>권한 없음 → **403**<br>그룹/목표 없음 → **404**<br>이미 배정됨 → **409** (UNIQUE) |

---

### 6.5 관리자 피드백

| 항목 | 내용 |
| --- | --- |
| **기능명** | 관리자 학습 피드백 작성·조회 |
| **행위 주체** | **작성**: OWNER/MANAGER · **조회**: OWNER/MANAGER(전체) 또는 MEMBER(본인 수신분만) |
| **사전 조건** | JWT 유효. `group_members.status=ACTIVE`. 작성 시 `target_member_id`가 동일 그룹 `group_members.id` |
| **처리 흐름** | **작성**<br>1. `POST /api/groups/:id/feedbacks` — `target_member_id`, `session_id`(선택), `content`<br>2. 요청자 `group_role IN (OWNER, MANAGER)` 검증<br>3. `manager_member_id` = 요청자 `group_members.id` 자동 설정<br>4. `manager_feedbacks` INSERT<br>5. `201` + `feedback_id`<br><br>**조회**<br>6. `GET /api/groups/:id/feedbacks` — `target_member_id`, `page`, `limit`<br>7. OWNER/MANAGER: 전체 또는 필터 조회<br>8. MEMBER: `target_member_id = 본인 group_members.id`만<br>9. `200` + `feedbacks[]`, `pagination` |
| **예외 처리** | 필수 필드 누락 → **400**<br>JWT 없음 → **401**<br>MEMBER가 작성 시도 → **403**<br>MEMBER가 타인 피드백 조회 → **403**<br>비구성원 → **403**<br>그룹/멤버/세션 없음 → **404** |

---

## 부록: 도메인·API·ERD 매핑

| 도메인 | 주요 API | ERD 테이블 |
| --- | --- | --- |
| 인증 | `/api/auth/*` | `users`, `user_profiles`, `user_privacy_settings` |
| 학습 세션 | `/api/sessions/*` | `sessions`, `concentration_logs` |
| 리포트 | `/api/reports/*` | `reports`, `concentration_logs`, `sessions` |
| 소셜 | `/api/connections/*`, `/api/rankings` | `user_connection_requests`, `user_connections` |
| 세션 공유 | `/api/session-shares/*` | `session_shares`, `session_reactions`, `user_privacy_settings` |
| 그룹 | `/api/groups/*` | `groups`, `group_members`, `group_invitations`, `group_goals`, `group_goal_assignees`, `manager_feedbacks` |
