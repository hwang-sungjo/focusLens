# FocusLens 최종 ERD 설계 문서

세션 기록 공유, 공감 기능, 온라인 네트워킹, 그룹 및 관리자 관리 시스템을 반영한 최종 ERD입니다.

---

## 1. ERD 점검 결과 요약

| 점검 항목 | 확인 및 수정 내용 | 결과 |
| --- | --- | --- |
| 중복 컬럼 | session_shares.user_id 제거. 세션 소유자는 sessions.user_id로만 판단. reaction_count/like_count/cheer_count도 제거하고 session_reactions에서 집계. | 통과 |
| 명명 규칙 | 테이블은 snake_case 복수형, PK는 id, FK는 {대상}_id 형식으로 통일. password → password_hash, intro → bio, create_at → created_at으로 정정. | 통과 |
| 관계 명확성 | 세션 공유는 sessions - session_shares - session_reactions으로 분리. 그룹 권한은 users가 아니라 group_members 기준으로 판단. | 통과 |
| 기본키 | 모든 물리 테이블은 UUID id를 PK로 가진다. 주요 중복 방지는 별도 UNIQUE 제약으로 처리. | 통과 |
| 다대다 관계 | users-groups, users-users, group_goals-group_members 관계는 각각 group_members, user_connections, group_goal_assignees 중간 테이블로 해소. | 통과 |
| 파생 컬럼 | 세션 평균 점수, 학습 시간, 공감 개수, 랭킹/그룹 통계는 기본 테이블에 저장하지 않음. 필요 시 조회용 View 또는 Materialized View로 제공. | 통과 |

---

## 2. 주요 오류 및 수정 사항

| 기존 설계 항목 | 문제점 | 최종 수정 방향 |
| --- | --- | --- |
| sessions.avg_focus_score, duration_seconds | concentration_logs 또는 started_at/ended_at에서 계산 가능한 파생 값 | sessions에서는 제거하고 리포트/조회 API에서 산출 |
| session_shares.user_id | session_id를 통해 sessions.user_id를 알 수 있어 중복 | 공유 주체는 session_id → sessions.user_id로 판단 |
| session_shares.like_count 등 | session_reactions에서 COUNT 가능한 파생 값 | 제거. v_session_share_reaction_counts 뷰로 제공 |
| groups.owner_id | group_members.group_role=OWNER와 의미 중복 가능 | created_by_user_id만 보존하고 실제 그룹 권한은 group_members에서 관리 |
| study_posts/post_reactions | 세션 자체를 게시물처럼 쓰는 요구와 불일치 | session_shares/session_reactions으로 대체 |
| nullable assigned_member_id | 그룹 목표와 개인 목표가 한 테이블에서 애매해짐 | group_goal_assignees 중간 테이블로 분리 |

---

## 3. 최종 테이블 목록

### 코어 도메인

| 테이블 | 주요 컬럼 | 설명 |
| --- | --- | --- |
| users | id(PK), email, password_hash, name, role, status, created_at, updated_at, deleted_at | 회원 인증 및 전역 권한 정보 |
| user_profiles | id(PK), user_id(FK, UNIQUE), nickname, profile_image_url, bio, created_at, updated_at | 네트워킹 공개 프로필 |
| user_privacy_settings | id(PK), user_id(FK, UNIQUE), default_session_scope, score_visibility, study_time_visibility, group_data_sharing, ranking_participation, created_at, updated_at | 학습 데이터 공개 범위 설정 |
| sessions | id(PK), user_id(FK), started_at, ended_at, status, created_at, updated_at | 사용자 학습 세션 원본 기록 |
| concentration_logs | id(PK), session_id(FK), logged_at, gaze_score, blink_score, head_score, focus_score, attention_state, face_detected, created_at | 분 단위 집중도 타임라인 기록 |
| reports | id(PK), session_id(FK, UNIQUE), summary_json, created_at | 세션 종료 후 생성되는 리포트 산출물 |

### 소셜 도메인

| 테이블 | 주요 컬럼 | 설명 |
| --- | --- | --- |
| user_connection_requests | id(PK), requester_user_id(FK), receiver_user_id(FK), status, created_at, updated_at | 친구 요청 및 수락 상태 관리 |
| user_connections | id(PK), user_a_id(FK), user_b_id(FK), created_at | 수락된 사용자 간 친구 관계 |
| session_shares | id(PK), session_id(FK), group_id(FK, NULL), share_scope, share_message, status, created_at, updated_at, deleted_at | 공개된 학습 세션. 피드의 게시물 역할 |
| session_reactions | id(PK), session_share_id(FK), user_id(FK), reaction_type, created_at | 공유 세션에 대한 좋아요/응원/공감 반응 |

### 그룹 도메인

| 테이블 | 주요 컬럼 | 설명 |
| --- | --- | --- |
| groups | id(PK), created_by_user_id(FK), name, description, group_type, visibility, status, created_at, updated_at, deleted_at | 학습 그룹 기본 정보 |
| group_members | id(PK), group_id(FK), user_id(FK), group_role, status, joined_at, created_at, updated_at | 그룹 구성원 및 그룹 내 권한 |
| group_invitations | id(PK), group_id(FK), inviter_member_id(FK), invitee_email, invitee_user_id(FK), invite_code, status, expires_at, created_at | 그룹 초대 관리 |
| group_goals | id(PK), group_id(FK), created_by_member_id(FK), title, description, target_study_minutes, target_focus_score, start_date, end_date, status, created_at, updated_at | 그룹 또는 구성원 대상 학습 목표 |
| group_goal_assignees | id(PK), group_goal_id(FK), group_member_id(FK), created_at | 목표가 특정 멤버에게 배정되는 관계 |
| manager_feedbacks | id(PK), group_id(FK), target_member_id(FK), manager_member_id(FK), session_id(FK, NULL), content, created_at, updated_at | 관리자의 그룹원 학습 피드백 |

---

## 4. 주요 관계 요약

| 관계 | 카디널리티 | 설명 |
| --- | --- | --- |
| users - user_profiles | 1 : 1 | user_profiles.user_id UNIQUE |
| users - user_privacy_settings | 1 : 1 | user_privacy_settings.user_id UNIQUE |
| users - sessions | 1 : N | 사용자 1명은 여러 학습 세션을 생성 |
| sessions - concentration_logs | 1 : N | UNIQUE(session_id, logged_at) 권장 |
| sessions - reports | 1 : 1 | 완료 세션 1개는 리포트 1개 생성. reports.session_id UNIQUE |
| sessions - session_shares | 1 : N | 세션은 공개 범위별로 공유 가능. 동일 scope 중복 공유 방지 필요 |
| session_shares - session_reactions | 1 : N | 공유 세션 1개는 여러 공감 반응을 받을 수 있음 |
| users - session_reactions | 1 : N | 사용자 1명은 여러 공유 세션에 반응 가능 |
| users - user_connections | 1 : N | 자기참조 친구 관계. user_a_id, user_b_id로 대칭 중복 방지 |
| users - groups | M : N 해소 | group_members 중간 테이블을 통해 가입 관계 표현 |
| groups - group_members | 1 : N | UNIQUE(group_id, user_id) |
| group_goals - group_members | M : N 해소 | group_goal_assignees 중간 테이블로 목표 배정 관계 표현 |
| group_members - manager_feedbacks | 1 : N | 피드백 작성자/대상자를 모두 group_members 기준으로 연결 |

---

## 5. 권장 제약조건 및 인덱스

| 테이블 | 권장 제약조건 |
| --- | --- |
| users | UNIQUE(email) |
| user_profiles | UNIQUE(user_id), UNIQUE(nickname) |
| user_privacy_settings | UNIQUE(user_id) |
| concentration_logs | UNIQUE(session_id, logged_at), CHECK(score BETWEEN 0 AND 100) |
| reports | UNIQUE(session_id) |
| user_connection_requests | CHECK(requester_user_id <> receiver_user_id) |
| user_connections | UNIQUE(user_a_id, user_b_id), CHECK(user_a_id <> user_b_id) |
| session_shares | UNIQUE(session_id, share_scope, group_id) 또는 부분 UNIQUE 인덱스 |
| session_reactions | UNIQUE(session_share_id, user_id, reaction_type) |
| group_members | UNIQUE(group_id, user_id) |
| group_invitations | UNIQUE(invite_code) |
| group_goal_assignees | UNIQUE(group_goal_id, group_member_id) |

---

## 6. 조회용 View 권장 사항

파생 데이터는 기본 테이블에 저장하지 않고 View 또는 Materialized View로 산출합니다.
랭킹 조회 빈도가 높을 경우 `v_rankings`는 Materialized View 전환을 검토합니다.

| View 이름 | 집계 기준 | 사용 목적 |
| --- | --- | --- |
| v_session_share_reaction_counts | session_reactions를 session_share_id, reaction_type 기준으로 집계 | 피드에서 좋아요/응원/공감 개수 표시 |
| v_user_session_summaries | sessions, concentration_logs, reports를 조인하여 세션 요약 생성 | 내 기록/공개 피드의 세션 카드 표시 |
| v_group_member_stats | group_members와 세션 기록을 기간별로 집계 | 관리자 그룹 대시보드 |
| v_rankings | ranking_participation=true가 허용된 세션만 집계 | 전체/친구/그룹 랭킹 |

> **설계 기준**: 기본 테이블에는 원본 사실 데이터만 저장하고, 좋아요 수/랭킹/기간별 평균 등 파생 값은 조회 시 계산하거나 별도 View로 관리한다.

---

## 7. 핵심 설계 원칙 (Cursor 작업 시 반드시 준수)

- `sessions`에 `avg_focus_score`, `duration_seconds` 컬럼 추가 금지 — 조회 시 `concentration_logs`에서 계산
- 그룹 권한은 반드시 `group_members.group_role` 기준으로 판단 — `groups.created_by_user_id` 단독 판단 금지
- 세션 공유 조회 시 `user_privacy_settings.default_session_scope` 준수 필수
- 공감 수, 랭킹 등 파생 값은 기본 테이블에 저장하지 않고 위 View에서 산출
- `session_shares.user_id` 컬럼 추가 금지 — 소유자는 `session_id → sessions.user_id`로 조회
