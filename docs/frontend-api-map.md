# FocusLens 프런트엔드 API 매핑

> 작성일: 2026-10-06  
> FE-1 기준 `main@ba3e859`에 소셜·그룹을 포함한 11개 화면이 있다. FE-2에서 브라우저로 기존 화면의 실제 API 흐름을 검증한다.
> API 상세: `docs/api-spec.md`, 실행 명세: `docs/swagger.yaml`
> 최신 로컬 실행·현재 화면 동작·검증 범위: [프런트 인계](frontend-handoff.md). 아래 표는 API 계약이며, 회원가입 후 로그인 화면으로 이동하는 현재 UX는 유지한다.

## 1. 화면별 API

| 화면·기능 | API | 주요 처리 |
| --- | --- | --- |
| 회원가입 | `POST /api/auth/register` | 성공하면 로그인 화면으로 이동 |
| 로그인 | `POST /api/auth/login` | 1시간 Access Token 사용, 30일 Refresh cookie 수신 |
| 토큰 갱신 | `POST /api/auth/refresh` | 1회 회전 후 원 요청 1회 재시도 |
| 로그아웃 | `POST /api/auth/logout` | 로컬 토큰 제거, Access 블랙리스트와 Refresh family 폐기 |
| 세션 시작 | `POST /api/sessions/start` | 중복 진행 세션 409 처리 |
| 세션 종료 | `POST /api/sessions/:id/end` | 종료 summary와 report ID 표시 |
| 내 세션 | `GET /api/sessions` | `page`, `limit`, `status`, 최대 100건 |
| 세션 상세 | `GET /api/sessions/:id` | MINUTE/HOUR/DAY/WEEK 타임라인 지원 |
| 세션 리포트 | `GET /api/reports/:session_id` | summary와 타임라인 |
| 주간·월간 | `GET /api/reports/weekly`, `/monthly` | 빈 날짜도 그대로 표시 |
| 공개 프로필 | `GET /api/users/:id/profile` | 공개 가능한 프로필만 표시 |
| 내 프로필 | `PATCH /api/users/me/profile` | nickname, bio, 이미지 URL |
| 프라이버시 | `GET/PATCH /api/users/me/privacy` | 공유·점수·시간·그룹·랭킹 설정 |
| 친구 | `POST /api/connections/request`, `PATCH /api/connections/:id`, `GET /api/connections` | 요청, 수락·거절·취소, 목록·대기 요청 |
| 세션 공유 | `POST /api/session-shares` | 완료 세션만 공유, 공개 범위 검증 |
| 소셜 피드 | `GET /api/session-shares/feed` | scope와 pagination, null 마스킹 지원 |
| 공감 | `POST /api/session-shares/:id/reactions`, `DELETE .../:reactionType` | LIKE/CHEER/EMPATHY |
| 랭킹 | `GET /api/rankings` | global/friends/group, daily/weekly |
| 그룹 목록·상세 | `GET/POST /api/groups`, `GET /api/groups/:id` | 내 역할과 멤버 수 표시 |
| 그룹 초대·참여 | `POST /api/groups/:id/invite`, `/api/groups/join` | OWNER/MANAGER 경계 표시 |
| 그룹 대시보드 | `GET /api/groups/:id/dashboard` | MEMBER는 self, 관리자만 all_members |
| 목표 | `POST/GET /api/groups/:id/goals`, `POST /api/groups/:id/goals/:goalId/assignees` | 생성·목록·대상 배정 |
| 피드백 | `POST/GET /api/groups/:id/feedbacks` | MEMBER는 본인 수신분만 조회 |

## 2. 공통 클라이언트 규칙

- 모든 보호 API에 `Authorization: Bearer <access_token>`을 보낸다.
- 모든 응답의 `{ success, data, error }` envelope를 확인한다.
- 응답 `X-Request-ID`를 오류 화면·고객 지원 로그에 함께 남긴다.
- 목록 기본값은 `page=1`, `limit=20`이고 최대 100이다.
- 같은 생성 시각의 데이터도 서버 정렬 순서를 그대로 유지한다.
- `avg_focus_score`, `duration_seconds`가 `null`이면 비공개 또는 데이터 없음으로 처리하고 0으로 임의 변환하지 않는다.
- 타임라인은 `granularity`에 따라 분·시간·일·주 표현을 바꾼다.

## 3. HTTP 오류 UX

| 상태 | 화면 처리 |
| --- | --- |
| 400 | 입력 필드 또는 요청 조건 오류 표시 |
| 401 | 보호 요청은 쿠키로 한 번 갱신한 뒤 재시도. 무효 Refresh 응답은 재로그인, 갱신 중 429·5xx·네트워크 오류는 로그인 상태 유지 |
| 403 | 로그인 상태를 유지하고 권한 부족 안내 |
| 404 | 삭제·비공개·없는 리소스 안내 후 상위 화면 이동 제공 |
| 409 | 중복 요청 또는 이미 변경된 상태 안내, 목록 새로고침 제공 |
| 500 | 일반 오류 문구와 `X-Request-ID` 표시 |
| 503 | 서비스 일시 장애 안내와 수동 재시도 제공 |

## 4. 보안·표시 규칙

- API 문자열은 HTML로 삽입하지 않고 프레임워크의 기본 text escaping을 사용한다.
- 토큰, 비밀번호, Refresh Token을 콘솔·분석 이벤트·오류 리포트에 기록하지 않는다.
- 프라이버시로 마스킹된 필드를 다른 API 결과와 결합해 복원하지 않는다.
- 그룹 관리 버튼은 역할에 따라 숨기되 서버 403을 최종 권한 판단으로 사용한다.
- 웹 클라이언트는 Access Token을 localStorage에 보관하고 Refresh Token은 HttpOnly 쿠키로 전송한다. 운영 CORS origin은 배포 주소가 정해질 때 확정한다.
