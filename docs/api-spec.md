# FocusLens API 명세서

> **기준 문서**: `docs/backend-plan.md` Phase 3 MVP 구현
> **Base URL**: `/api`  
> **인증 방식**: JWT Bearer Token (`Authorization: Bearer <access_token>`)  
> **토큰 만료**: Access Token 1시간

**구현 현황 (2026-09-22):** 아래 36개 API operation은 `backend/src/routes`에 구현돼 있으며 `docs/swagger.yaml`에 명세돼 있다. 인증은 Access Token만 지원하고 토큰 재발급 API는 없다. `GET /health`(DB·Redis 정상 시 200, 장애 시 503)와 `/api-docs`는 `/api` 밖의 백엔드 운영 경로다. AI 측 로그 API 클라이언트는 존재하지만 웹캠 측정 결과의 자동 전송은 아직 연결되지 않았다. 운영·통합 검증 상태는 `docs/backend-plan.md` Phase 4·5를 따른다.

---

## 1. 공통 규약

### 1.1 응답 형식

모든 API는 아래 형식으로 응답한다.

**성공**

```json
{
  "success": true,
  "data": {},
  "error": ""
}
```

**실패**

```json
{
  "success": false,
  "data": {},
  "error": "에러 메시지"
}
```

### 1.2 HTTP 상태 코드

| 코드 | 의미 |
| --- | --- |
| 200 | 성공 (조회·수정·종료 등) |
| 201 | 생성 성공 |
| 400 | 요청 형식 오류, 유효성 검증 실패 |
| 401 | 인증 토큰 없음·만료·무효 |
| 403 | 권한 없음 (소유자 불일치, 그룹 역할 부족, 프라이버시 위반) |
| 404 | 리소스 없음 |
| 409 | 중복 리소스 (이메일 중복, 이미 연결된 친구 등) |
| 500 | 서버 내부 오류 |

### 1.3 그룹 권한 판단 원칙

그룹 관련 API의 접근 제어는 **반드시 `group_members.group_role`** 기준으로 판단한다.

| 역할 | 설명 |
| --- | --- |
| `OWNER` | 그룹 최고 권한. 멤버 `group_role` 변경 가능 |
| `MANAGER` | 초대·목표·피드백 작성 등 관리 기능 수행 |
| `MEMBER` | 일반 구성원. 제한된 조회·참여 권한 |

> `groups.created_by_user_id`는 생성 이력 보존용이며, **권한 판단에 단독 사용하지 않는다.**  
> JWT `sub`(user_id)로 해당 그룹의 `group_members` 레코드를 조회한 뒤 `group_role`을 검증한다.

### 1.4 집중도 점수 산정

```
focus_score = (gaze × 0.4) + (blink × 0.3) + (head × 0.3)
```

백엔드는 요청의 `total`이 위 계산값(소수 둘째 자리 반올림)과 0.01 이내로 일치하는지 확인하고 계산값을 저장한다. 현재 `ai/`에는 같은 가중치의 계산 함수와 API 클라이언트가 있지만, 1분 점수 집계와 실시간 전송 연결은 미구현이다.

| 구간 | attention_state |
| --- | --- |
| ≥ 70 | `FOCUSED` |
| 40 ~ 69 | `NORMAL` |
| < 40 | `DISTRACTED` |

---

## 2. 인증 (Auth)

### POST /api/auth/register

회원가입. 가입 시 `user_profiles`, `user_privacy_settings`가 기본값으로 자동 생성된다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/auth/register` |
| **인증** | 불필요 |

**Request Body**

```json
{
  "email": "user@example.com",
  "password": "string (8자 이상)",
  "name": "홍길동",
  "nickname": "focus_master"
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "user_id": "uuid",
    "email": "user@example.com",
    "name": "홍길동",
    "access_token": "jwt",
    "expires_in": 3600
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"email, password, name, nickname은 필수입니다"` |
| 400 | `"비밀번호는 8자 이상이어야 합니다"` |
| 409 | `"이미 등록된 이메일입니다"` |
| 409 | `"이미 사용 중인 닉네임입니다"` |

---

### POST /api/auth/login

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/auth/login` |
| **인증** | 불필요 |

**Request Body**

```json
{
  "email": "user@example.com",
  "password": "string"
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "user_id": "uuid",
    "access_token": "jwt",
    "expires_in": 3600
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"email과 password는 필수입니다"` |
| 401 | `"이메일 또는 비밀번호가 올바르지 않습니다"` |
| 403 | `"비활성화된 계정입니다"` |

---

### POST /api/auth/logout

현재 access token을 Redis 블랙리스트에 등록하여 무효화한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/auth/logout` |
| **인증** | **필요** |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "message": "로그아웃되었습니다"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 401 | `"만료되었거나 유효하지 않은 토큰입니다"` |

---

## 3. 학습 세션 (Sessions)

> 세션 소유자 검증: `sessions.user_id` = JWT `sub`  
> `avg_focus_score`, `duration_seconds`는 DB에 저장하지 않고 `concentration_logs`에서 조회 시 계산한다.

### POST /api/sessions/start

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/sessions/start` |
| **인증** | **필요** |

**Request Body**

```json
{}
```

> `user_id`는 Request Body가 아닌 JWT `sub`에서 추출한다.

**Response `201`**

```json
{
  "success": true,
  "data": {
    "session_id": "uuid",
    "started_at": "2026-06-27T09:00:00.000Z",
    "status": "IN_PROGRESS"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 409 | `"이미 진행 중인 세션이 있습니다"` |

---

### POST /api/sessions/:id/log

분 단위 집중도 로그 저장용 API. 현재 구현은 동일 세션의 60초 미만 재전송을 Redis로 차단하고, `logged_at`은 서버 수신 시각으로 기록한다. AI 측 실패 로그의 원래 측정 시각·재전송 정책은 통합 단계에서 확정해야 한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/sessions/:id/log` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 세션 UUID |

**Request Body**

```json
{
  "gaze": 85.5,
  "blink": 72.0,
  "head": 90.0,
  "total": 82.8,
  "face_detected": true
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `gaze` | float | 0~100, gaze_score |
| `blink` | float | 0~100, blink_score |
| `head` | float | 0~100, head_score |
| `total` | float | 0~100, focus_score (가중 합산값) |
| `face_detected` | boolean (선택) | AI가 산출한 분 단위 얼굴 검출 상태. 생략 시 현재 백엔드는 `true`로 저장 |

현재 AI API 클라이언트는 이 형태의 payload를 만들 수 있으나 웹캠 측정 루프에서 호출되지 않는다. 분 단위 `face_detected` 산출도 아직 구현되지 않았다.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "log_id": "uuid",
    "logged_at": "2026-06-27T09:01:00.000Z",
    "focus_score": 82.8,
    "attention_state": "FOCUSED",
    "face_detected": true
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"gaze, blink, head, total은 0~100 범위의 float여야 합니다"` |
| 400 | `"total은 가중 합산값과 일치해야 합니다"` 또는 `face_detected` 타입 오류 |
| 400 | `"1분 미만 중복 로그 전송입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 세션에 대한 권한이 없습니다"` |
| 404 | `"세션을 찾을 수 없습니다"` |
| 409 | `"종료된 세션에는 로그를 추가할 수 없습니다"` |

---

### POST /api/sessions/:id/end

세션 종료 및 리포트 자동 생성.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/sessions/:id/end` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 세션 UUID |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "session_id": "uuid",
    "report_id": "uuid",
    "ended_at": "2026-06-27T10:00:00.000Z",
    "status": "COMPLETED",
    "summary": {
      "avg_focus_score": 78.5,
      "duration_seconds": 3600,
      "gaze_avg": 80.2,
      "blink_avg": 75.1,
      "head_avg": 79.8,
      "focused_minutes": 45,
      "distracted_minutes": 5
    }
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 세션에 대한 권한이 없습니다"` |
| 404 | `"세션을 찾을 수 없습니다"` |
| 409 | `"이미 종료된 세션입니다"` |

---

### GET /api/sessions

내 세션 목록 조회. 최신순 정렬.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/sessions` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `page` | N | 페이지 번호 (기본 1) |
| `limit` | N | 페이지 크기 (기본 20, 최대 100) |
| `status` | N | `IN_PROGRESS` \| `COMPLETED` \| `CANCELLED` |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "session_id": "uuid",
        "started_at": "2026-06-27T09:00:00.000Z",
        "ended_at": "2026-06-27T10:00:00.000Z",
        "status": "COMPLETED",
        "avg_focus_score": 78.5,
        "duration_seconds": 3600
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 42
    }
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 400 | `"status 값이 올바르지 않습니다"` |

---

### GET /api/sessions/:id

세션 상세 및 분 단위 집중도 타임라인 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/sessions/:id` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 세션 UUID |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "session_id": "uuid",
    "started_at": "2026-06-27T09:00:00.000Z",
    "ended_at": "2026-06-27T10:00:00.000Z",
    "status": "COMPLETED",
    "avg_focus_score": 78.5,
    "duration_seconds": 3600,
    "timeline": [
      {
        "logged_at": "2026-06-27T09:01:00.000Z",
        "gaze_score": 85.5,
        "blink_score": 72.0,
        "head_score": 90.0,
        "focus_score": 82.8,
        "attention_state": "FOCUSED",
        "face_detected": true
      }
    ]
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 세션에 대한 권한이 없습니다"` |
| 404 | `"세션을 찾을 수 없습니다"` |

---

## 4. 리포트 (Reports)

### GET /api/reports/:session_id

세션별 집중도 리포트 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/reports/:session_id` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `session_id` | 세션 UUID |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "report_id": "uuid",
    "session_id": "uuid",
    "summary_json": {
      "avg_focus_score": 78.5,
      "duration_seconds": 3600,
      "gaze_avg": 80.2,
      "blink_avg": 75.1,
      "head_avg": 79.8,
      "focused_minutes": 45,
      "normal_minutes": 10,
      "distracted_minutes": 5
    },
    "timeline": [
      {
        "logged_at": "2026-06-27T09:01:00.000Z",
        "gaze_score": 85.5,
        "blink_score": 72.0,
        "head_score": 90.0,
        "focus_score": 82.8,
        "attention_state": "FOCUSED"
      }
    ],
    "created_at": "2026-06-27T10:00:05.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 세션에 대한 권한이 없습니다"` |
| 404 | `"세션을 찾을 수 없습니다"` |
| 404 | `"리포트가 아직 생성되지 않았습니다"` |

---

### GET /api/reports/weekly

최근 7일 일별 평균 집중도 요약.
`daily_summaries`는 데이터가 없는 날짜를 포함해 7개 날짜를 반환하며 해당 날짜 평균은 `null`이다. 기간 전체에 로그가 없으면 `weekly_avg_focus_score`도 `null`이다.
아래 응답 예시는 `daily_summaries` 배열의 한 날짜만 보여준다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/reports/weekly` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `end_date` | N | 기준 종료일 (ISO 8601 date, 기본 오늘) |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "period": {
      "start_date": "2026-06-21",
      "end_date": "2026-06-27"
    },
    "daily_summaries": [
      {
        "date": "2026-06-27",
        "session_count": 2,
        "total_study_seconds": 7200,
        "avg_focus_score": 76.3
      }
    ],
    "weekly_avg_focus_score": 74.8,
    "weekly_total_study_seconds": 28800
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 400 | `"end_date 형식이 올바르지 않습니다"` |

---

### GET /api/reports/monthly

기준일을 포함한 최근 30일의 일별 집중도 요약. `COMPLETED` 세션만 집계한다.
`daily_summaries`는 데이터가 없는 날짜를 포함해 30개 날짜를 반환하며 해당 날짜 평균은 `null`이다. 기간 전체에 로그가 없으면 `monthly_avg_focus_score`도 `null`이다.
아래 응답 예시는 `daily_summaries` 배열의 한 날짜만 보여준다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/reports/monthly` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `end_date` | N | 기준 종료일 (`YYYY-MM-DD`, 기본 오늘) |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "period": {
      "start_date": "2026-05-29",
      "end_date": "2026-06-27"
    },
    "daily_summaries": [
      {
        "date": "2026-06-27",
        "session_count": 2,
        "total_study_seconds": 7200,
        "avg_focus_score": 76.3
      }
    ],
    "monthly_avg_focus_score": 74.8,
    "monthly_total_study_seconds": 86400
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"end_date 형식이 올바르지 않습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |

---

## 5. 사용자 프로필 및 프라이버시 (Users)

### GET /api/users/:id/profile

활성 사용자의 공개 프로필을 조회한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/users/:id/profile` |
| **인증** | **필요** |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "user_id": "uuid",
    "nickname": "focus_master",
    "profile_image_url": "https://example.com/profile.png",
    "bio": "매일 집중하는 개발자"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"유효한 사용자 ID가 아닙니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 404 | `"프로필을 찾을 수 없습니다"` |

---

### PATCH /api/users/me/profile

내 닉네임, 소개, 프로필 이미지 URL을 수정한다. 전달한 필드만 변경한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `PATCH` |
| **Path** | `/api/users/me/profile` |
| **인증** | **필요** |

**Request Body**

```json
{
  "nickname": "focus_master",
  "bio": "매일 집중하는 개발자",
  "profile_image_url": "https://example.com/profile.png"
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "user_id": "uuid",
    "nickname": "focus_master",
    "bio": "매일 집중하는 개발자",
    "profile_image_url": "https://example.com/profile.png",
    "updated_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"nickname은 2~30자여야 합니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 409 | `"이미 존재하는 데이터입니다"` |

---

### GET /api/users/me/privacy

내 세션 공개 범위와 랭킹 참여 설정을 조회한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/users/me/privacy` |
| **인증** | **필요** |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "default_session_scope": "PRIVATE",
    "score_visibility": "PRIVATE",
    "study_time_visibility": "PRIVATE",
    "group_data_sharing": true,
    "ranking_participation": false
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 404 | `"프라이버시 설정을 찾을 수 없습니다"` |

---

### PATCH /api/users/me/privacy

내 프라이버시 설정을 수정한다. 전달한 필드만 변경한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `PATCH` |
| **Path** | `/api/users/me/privacy` |
| **인증** | **필요** |

**Request Body**

```json
{
  "default_session_scope": "FRIENDS",
  "score_visibility": "FRIENDS",
  "study_time_visibility": "PRIVATE",
  "group_data_sharing": true,
  "ranking_participation": true
}
```

> 공개 범위 값은 `PUBLIC`, `FRIENDS`, `GROUP`, `PRIVATE` 중 하나다.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "default_session_scope": "FRIENDS",
    "score_visibility": "FRIENDS",
    "study_time_visibility": "PRIVATE",
    "group_data_sharing": true,
    "ranking_participation": true
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"유효한 공개 범위가 아닙니다"` |
| 401 | `"인증 토큰이 필요합니다"` |

---

## 6. 소셜 — 친구 연결 (Connections)

### POST /api/connections/request

친구 요청 전송.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/connections/request` |
| **인증** | **필요** |

**Request Body**

```json
{
  "receiver_user_id": "uuid"
}
```

> `requester_user_id`는 JWT `sub`에서 추출한다. 자기 자신에게 요청할 수 없다.

**Response `201`**

```json
{
  "success": true,
  "data": {
    "request_id": "uuid",
    "requester_user_id": "uuid",
    "receiver_user_id": "uuid",
    "status": "PENDING",
    "created_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"receiver_user_id는 필수입니다"` |
| 400 | `"자기 자신에게 친구 요청을 보낼 수 없습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 404 | `"대상 사용자를 찾을 수 없습니다"` |
| 409 | `"이미 친구 관계입니다"` |
| 409 | `"이미 처리 대기 중인 요청이 있습니다"` |

---

### PATCH /api/connections/:id

친구 요청 수락·거절·취소.

| 항목 | 내용 |
| --- | --- |
| **Method** | `PATCH` |
| **Path** | `/api/connections/:id` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 친구 요청(`user_connection_requests`) UUID |

**Request Body**

```json
{
  "status": "ACCEPTED"
}
```

| status | 설명 |
| --- | --- |
| `ACCEPTED` | 수락 → `user_connections` 레코드 생성 |
| `REJECTED` | 거절 |
| `CANCELLED` | 요청자 본인이 취소 |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "request_id": "uuid",
    "status": "ACCEPTED",
    "connection_id": "uuid"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"status는 ACCEPTED, REJECTED, CANCELLED 중 하나여야 합니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 요청을 처리할 권한이 없습니다"` |
| 404 | `"친구 요청을 찾을 수 없습니다"` |
| 409 | `"이미 처리된 요청입니다"` |

---

### GET /api/connections

친구 목록 및 대기 중인 요청 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/connections` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `include_pending` | N | `true` 시 수신·발신 대기 요청 포함 (기본 `false`) |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "connections": [
      {
        "connection_id": "uuid",
        "user_id": "uuid",
        "nickname": "focus_master",
        "profile_image_url": "https://...",
        "connected_at": "2026-06-20T12:00:00.000Z"
      }
    ],
    "pending_received": [],
    "pending_sent": []
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |

---

## 7. 소셜 — 세션 공유 (Session Shares)

> 세션 소유자: `session_id` → `sessions.user_id` ( `session_shares.user_id` 컬럼 없음 )  
> 공유 시 `user_privacy_settings.default_session_scope`를 초과하는 공개는 차단한다.

### POST /api/session-shares

학습 세션 공유(피드 게시).

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/session-shares` |
| **인증** | **필요** |

**Request Body**

```json
{
  "session_id": "uuid",
  "share_scope": "FRIENDS",
  "group_id": null,
  "share_message": "오늘도 1시간 집중!"
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `session_id` | uuid | 공유할 세션 |
| `share_scope` | enum | `PUBLIC` \| `FRIENDS` \| `GROUP` |
| `group_id` | uuid \| null | `share_scope=GROUP`일 때 **필수** |
| `share_message` | string | 선택, 공유 메시지 |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "share_id": "uuid",
    "session_id": "uuid",
    "share_scope": "FRIENDS",
    "group_id": null,
    "share_message": "오늘도 1시간 집중!",
    "status": "ACTIVE",
    "created_at": "2026-06-27T10:05:00.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"session_id와 share_scope는 필수입니다"` |
| 400 | `"GROUP 공유 시 group_id는 필수입니다"` |
| 400 | `"share_scope 값이 올바르지 않습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 세션에 대한 권한이 없습니다"` |
| 403 | `"프라이버시 설정(default_session_scope)보다 넓은 범위로 공유할 수 없습니다"` |
| 403 | `"해당 그룹의 구성원이 아닙니다"` |
| 404 | `"세션을 찾을 수 없습니다"` |
| 409 | `"동일 범위로 이미 공유된 세션입니다"` |
| 409 | `"진행 중인 세션은 공유할 수 없습니다"` |

---

### GET /api/session-shares/feed

소셜 피드 조회. 친구 공개·전체 공개 세션을 통합 반환한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/session-shares/feed` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `page` | N | 페이지 번호 (기본 1) |
| `limit` | N | 페이지 크기 (기본 20) |
| `scope` | N | `all` \| `friends` \| `public` (기본 `all`) |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "feed": [
      {
        "share_id": "uuid",
        "session_id": "uuid",
        "share_scope": "PUBLIC",
        "share_message": "오늘도 1시간 집중!",
        "owner": {
          "user_id": "uuid",
          "nickname": "focus_master",
          "profile_image_url": "https://..."
        },
        "session_summary": {
          "started_at": "2026-06-27T09:00:00.000Z",
          "duration_seconds": 3600,
          "avg_focus_score": 78.5
        },
        "reaction_counts": {
          "LIKE": 12,
          "CHEER": 5,
          "EMPATHY": 3
        },
        "my_reactions": ["LIKE"],
        "created_at": "2026-06-27T10:05:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100
    }
  },
  "error": ""
}
```

> `session_summary`의 점수·학습 시간은 세션 소유자의 `score_visibility`, `study_time_visibility`에 따라 마스킹될 수 있다.  
> `reaction_counts`는 `v_session_share_reaction_counts` View 기반.

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 400 | `"scope 값이 올바르지 않습니다"` |

---

### POST /api/session-shares/:id/reactions

공유 세션에 공감 반응 추가.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/session-shares/:id/reactions` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | session_share UUID |

**Request Body**

```json
{
  "reaction_type": "LIKE"
}
```

| reaction_type | 설명 |
| --- | --- |
| `LIKE` | 좋아요 |
| `CHEER` | 응원 |
| `EMPATHY` | 공감 |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "reaction_id": "uuid",
    "session_share_id": "uuid",
    "reaction_type": "LIKE",
    "created_at": "2026-06-27T10:10:00.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"reaction_type은 LIKE, CHEER, EMPATHY 중 하나여야 합니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 공유 게시물에 접근할 수 없습니다"` |
| 404 | `"공유 게시물을 찾을 수 없습니다"` |
| 409 | `"이미 동일 유형의 반응을 남겼습니다"` |

---

### DELETE /api/session-shares/:id/reactions/:reactionType

내가 남긴 특정 유형의 공감 반응을 취소한다. 반응이 이미 없어도 성공으로 처리한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `DELETE` |
| **Path** | `/api/session-shares/:id/reactions/:reactionType` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | session_share UUID |
| `reactionType` | `LIKE` \| `CHEER` \| `EMPATHY` |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "message": "공감 반응이 취소되었습니다."
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"reactionType 값이 올바르지 않습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 공유 게시물에 접근할 수 없습니다"` |
| 404 | `"공유 게시물을 찾을 수 없습니다"` |

---

## 8. 랭킹 (Rankings)

### GET /api/rankings

집중도·학습 시간 랭킹 조회. `ranking_participation=false` 사용자는 집계에서 제외한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/rankings` |
| **인증** | **필요** |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `scope` | Y | `global` \| `friends` \| `group` |
| `period` | Y | `daily` \| `weekly` |
| `metric` | Y | `focus_score` \| `study_time` |
| `group_id` | 조건부 | `scope=group`일 때 **필수** |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "scope": "global",
    "period": "weekly",
    "metric": "focus_score",
    "rankings": [
      {
        "rank": 1,
        "user_id": "uuid",
        "nickname": "focus_master",
        "profile_image_url": "https://...",
        "value": 85.2,
        "session_count": 12
      }
    ],
    "my_rank": {
      "rank": 15,
      "value": 72.1
    }
  },
  "error": ""
}
```

> `rankings` 데이터는 `v_rankings` View 기반.  
> `scope=group` 시 요청자는 해당 그룹의 `group_members` (status=`ACTIVE`) 여야 한다.

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"scope, period, metric은 필수입니다"` |
| 400 | `"scope=group일 때 group_id는 필수입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"해당 그룹의 구성원이 아닙니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

## 9. 그룹 (Groups)

### GET /api/groups

JWT 사용자가 `ACTIVE` 구성원으로 속한 그룹 목록을 최근 참여순으로 조회한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/groups` |
| **인증** | **필요** |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "groups": [
      {
        "group_id": "uuid",
        "name": "CS 스터디",
        "description": "알고리즘 집중 스터디",
        "group_type": "STUDY",
        "visibility": "PRIVATE",
        "status": "ACTIVE",
        "member_count": 8,
        "my_role": "MEMBER",
        "joined_at": "2026-06-27T09:00:00.000Z",
        "created_at": "2026-06-20T09:00:00.000Z"
      }
    ]
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |

---

### POST /api/groups

그룹 생성. 생성자는 `group_members`에 `group_role=OWNER`로 자동 등록된다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups` |
| **인증** | **필요** |

**Request Body**

```json
{
  "name": "CS 스터디",
  "description": "알고리즘 집중 스터디",
  "group_type": "STUDY",
  "visibility": "PRIVATE"
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `name` | string | 그룹명 |
| `description` | string | 선택 |
| `group_type` | enum | `STUDY` \| `PROJECT` \| `CHALLENGE` |
| `visibility` | enum | `PUBLIC` \| `PRIVATE` |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "group_id": "uuid",
    "name": "CS 스터디",
    "description": "알고리즘 집중 스터디",
    "group_type": "STUDY",
    "visibility": "PRIVATE",
    "status": "ACTIVE",
    "my_role": "OWNER",
    "created_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 단계 | 검증 |
| --- | --- |
| 생성 후 | JWT `sub` 사용자 → `group_members.group_role = OWNER` 자동 등록 |
| `groups.created_by_user_id` | 이력 보존용 설정. 권한 판단에는 사용하지 않음 |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"name은 필수입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |

---

### GET /api/groups/:id

그룹 상세 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/groups/:id` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "group_id": "uuid",
    "name": "CS 스터디",
    "description": "알고리즘 집중 스터디",
    "group_type": "STUDY",
    "visibility": "PRIVATE",
    "status": "ACTIVE",
    "member_count": 8,
    "my_role": "MEMBER",
    "created_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| visibility | 허용 조건 |
| --- | --- |
| `PUBLIC` | 인증된 모든 사용자 조회 가능 |
| `PRIVATE` | `group_members`에 `status=ACTIVE`인 구성원만 조회 가능 |

> `my_role`은 JWT `sub` 사용자의 `group_members.group_role`. 비구성원이면 `null`.

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"비공개 그룹은 구성원만 조회할 수 있습니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

### POST /api/groups/join

초대 코드로 그룹에 참여한다. 초대 대상 사용자 ID 또는 이메일이 JWT 사용자와 일치해야 한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups/join` |
| **인증** | **필요** |

**Request Body**

```json
{
  "invite_code": "ABC123XYZ"
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "group_id": "uuid",
    "member_id": "uuid",
    "group_role": "MEMBER",
    "joined_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"만료되었거나 이미 사용된 초대 코드입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"초대 대상 사용자와 일치하지 않습니다"` |
| 404 | `"유효하지 않은 초대 코드입니다"` |
| 409 | `"이미 그룹 구성원입니다"` |

---

### POST /api/groups/:id/invite

그룹 초대 생성.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups/:id/invite` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Request Body**

```json
{
  "invitee_email": "friend@example.com",
  "invitee_user_id": null,
  "expires_in_days": 7
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `invitee_email` | string | 초대 대상 이메일 (둘 중 하나 필수) |
| `invitee_user_id` | uuid | 초대 대상 user_id |
| `expires_in_days` | int | 만료일 (기본 7일) |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "invitation_id": "uuid",
    "invite_code": "ABC123XYZ",
    "invitee_email": "friend@example.com",
    "status": "PENDING",
    "expires_at": "2026-07-04T09:00:00.000Z",
    "created_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 역할 | `OWNER`, `MANAGER` |
| --- | --- |
| 검증 방법 | JWT `sub` → `group_members` WHERE `group_id=:id` AND `status=ACTIVE` → `group_role` IN (`OWNER`, `MANAGER`) |
| 거부 | `MEMBER` 또는 비구성원 → **403** |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"invitee_email 또는 invitee_user_id 중 하나는 필수입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"그룹 초대 권한이 없습니다 (OWNER 또는 MANAGER 필요)"` |
| 404 | `"그룹을 찾을 수 없습니다"` |
| 409 | `"이미 그룹 구성원입니다"` |

---

### PATCH /api/groups/:id/members/:memberId

그룹 멤버 역할(`group_role`) 변경.

| 항목 | 내용 |
| --- | --- |
| **Method** | `PATCH` |
| **Path** | `/api/groups/:id/members/:memberId` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |
| `memberId` | `group_members.id` UUID |

**Request Body**

```json
{
  "group_role": "MANAGER"
}
```

| group_role | 설명 |
| --- | --- |
| `OWNER` | 그룹 소유자 (양도 시에만 설정) |
| `MANAGER` | 관리자 |
| `MEMBER` | 일반 구성원 |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "member_id": "uuid",
    "user_id": "uuid",
    "group_role": "MANAGER",
    "updated_at": "2026-06-27T10:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 역할 | `OWNER`만 가능 |
| --- | --- |
| 검증 방법 | JWT `sub` → 요청자의 `group_members.group_role = OWNER` 확인 |
| 추가 제약 | OWNER 본인의 역할을 MEMBER로 강등 불가 (OWNER 0명 방지) |
| OWNER 양도 | `group_role=OWNER`로 변경 시 기존 OWNER는 MANAGER로 강등 |

> `groups.created_by_user_id`가 요청자와 일치하더라도, `group_members.group_role ≠ OWNER`이면 **403**.

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"group_role은 OWNER, MANAGER, MEMBER 중 하나여야 합니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"멤버 역할 변경은 OWNER만 가능합니다"` |
| 403 | `"OWNER 본인을 MEMBER로 변경할 수 없습니다"` |
| 404 | `"그룹 또는 멤버를 찾을 수 없습니다"` |

---

### DELETE /api/groups/:id/members/:memberId

그룹 구성원을 내보내고 `group_members.status`를 `REMOVED`로 변경한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `DELETE` |
| **Path** | `/api/groups/:id/members/:memberId` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |
| `memberId` | `group_members.id` UUID |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "member_id": "uuid",
    "status": "REMOVED"
  },
  "error": ""
}
```

**접근 제어**

| 요청자 | 허용 범위 |
| --- | --- |
| `OWNER` | OWNER가 아닌 활성 구성원 내보내기 가능 |
| `MANAGER` | MEMBER 또는 본인 내보내기 가능, 다른 MANAGER와 OWNER는 불가 |
| `MEMBER` / 비구성원 | 실행 불가 |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"OWNER는 그룹에서 내보낼 수 없습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"멤버 내보내기 권한이 없습니다"` |
| 404 | `"멤버를 찾을 수 없습니다"` |

---

### GET /api/groups/:id/dashboard

`v_group_member_stats` 기반 그룹 학습 통계를 조회한다.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/groups/:id/dashboard` |
| **인증** | **필요** |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "group_id": "uuid",
    "scope": "all_members",
    "members": [
      {
        "group_member_id": "uuid",
        "user_id": "uuid",
        "group_role": "MEMBER",
        "nickname": "focus_master",
        "profile_image_url": "https://example.com/profile.png",
        "total_sessions": 12,
        "total_study_seconds": 28800,
        "avg_focus_score": 78.5,
        "last_session_at": "2026-06-27T09:00:00.000Z"
      }
    ]
  },
  "error": ""
}
```

**접근 제어**

| 역할 | `scope` | 조회 범위 |
| --- | --- | --- |
| `OWNER`, `MANAGER` | `all_members` | 전체 활성 구성원 |
| `MEMBER` | `self` | 본인 통계만 |
| 비구성원 | — | **403** |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"그룹 구성원만 대시보드를 조회할 수 있습니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

## 10. 그룹 목표 (Group Goals)

### POST /api/groups/:id/goals

그룹 학습 목표 생성.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups/:id/goals` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Request Body**

```json
{
  "title": "주간 10시간 집중",
  "description": "6월 4주차 목표",
  "target_study_minutes": 600,
  "target_focus_score": 75.0,
  "start_date": "2026-06-23",
  "end_date": "2026-06-29"
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "goal_id": "uuid",
    "group_id": "uuid",
    "title": "주간 10시간 집중",
    "description": "6월 4주차 목표",
    "target_study_minutes": 600,
    "target_focus_score": 75.0,
    "start_date": "2026-06-23",
    "end_date": "2026-06-29",
    "status": "ACTIVE",
    "created_at": "2026-06-27T09:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 역할 | `OWNER`, `MANAGER` |
| --- | --- |
| 검증 방법 | JWT `sub` → `group_members.group_role` IN (`OWNER`, `MANAGER`) |
| `created_by_member_id` | 요청자의 `group_members.id` 저장 |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"title, start_date, end_date는 필수입니다"` |
| 400 | `"target_focus_score는 0~100 범위여야 합니다"` |
| 400 | `"end_date는 start_date 이후여야 합니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"목표 생성 권한이 없습니다 (OWNER 또는 MANAGER 필요)"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

### GET /api/groups/:id/goals

그룹 목표 목록 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/groups/:id/goals` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `status` | N | `ACTIVE` \| `COMPLETED` \| `CANCELLED` |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "goals": [
      {
        "goal_id": "uuid",
        "title": "주간 10시간 집중",
        "description": "6월 4주차 목표",
        "target_study_minutes": 600,
        "target_focus_score": 75.0,
        "start_date": "2026-06-23",
        "end_date": "2026-06-29",
        "status": "ACTIVE",
        "assignee_count": 3,
        "is_assigned_to_me": true,
        "created_at": "2026-06-27T09:00:00.000Z"
      }
    ]
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 조건 | `group_members.status=ACTIVE`인 구성원 |
| --- | --- |
| `OWNER`, `MANAGER`, `MEMBER` | 모두 목록 조회 가능 |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"그룹 구성원만 목표를 조회할 수 있습니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

### POST /api/groups/:id/goals/:goalId/assignees

목표를 특정 그룹 멤버에게 배정.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups/:id/goals/:goalId/assignees` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |
| `goalId` | group_goals UUID |

**Request Body**

```json
{
  "group_member_ids": ["uuid", "uuid"]
}
```

> `group_member_ids`가 빈 배열이거나 생략 시 **전체 구성원 대상** 목표로 간주 (`group_goal_assignees` 레코드 없음).

**Response `201`**

```json
{
  "success": true,
  "data": {
    "goal_id": "uuid",
    "assignees": [
      {
        "assignment_id": "uuid",
        "group_member_id": "uuid",
        "user_id": "uuid",
        "nickname": "focus_master"
      }
    ],
    "is_group_wide": false
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 역할 | `OWNER`, `MANAGER` |
| --- | --- |
| 검증 방법 | JWT `sub` → `group_members.group_role` IN (`OWNER`, `MANAGER`) |
| 대상 검증 | `group_member_ids` 각각이 동일 `group_id` 소속인지 확인 |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"group_member_ids에 유효하지 않은 멤버가 포함되어 있습니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"목표 배정 권한이 없습니다 (OWNER 또는 MANAGER 필요)"` |
| 404 | `"그룹 또는 목표를 찾을 수 없습니다"` |
| 409 | `"이미 배정된 멤버입니다"` |

---

## 11. 관리자 피드백 (Manager Feedbacks)

> 피드백 작성자·대상자 모두 `group_members.id` 기준으로 연결한다.

### POST /api/groups/:id/feedbacks

관리자 학습 피드백 작성.

| 항목 | 내용 |
| --- | --- |
| **Method** | `POST` |
| **Path** | `/api/groups/:id/feedbacks` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Request Body**

```json
{
  "target_member_id": "uuid",
  "session_id": "uuid",
  "content": "오늘 집중도가 좋았습니다. Head 점수를 조금 더 올려보세요."
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `target_member_id` | uuid | 피드백 대상 `group_members.id` |
| `session_id` | uuid | 선택, 참조 세션 |
| `content` | string | 피드백 내용 |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "feedback_id": "uuid",
    "group_id": "uuid",
    "target_member_id": "uuid",
    "manager_member_id": "uuid",
    "session_id": "uuid",
    "content": "오늘 집중도가 좋았습니다. Head 점수를 조금 더 올려보세요.",
    "created_at": "2026-06-27T11:00:00.000Z"
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 허용 역할 | `OWNER`, `MANAGER` |
| --- | --- |
| 검증 방법 | JWT `sub` → 요청자 `group_members.group_role` IN (`OWNER`, `MANAGER`) |
| `manager_member_id` | 요청자의 `group_members.id` 자동 설정 |
| 대상 검증 | `target_member_id`가 동일 그룹 소속 `group_members.id` |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 400 | `"target_member_id와 content는 필수입니다"` |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"피드백 작성 권한이 없습니다 (OWNER 또는 MANAGER 필요)"` |
| 403 | `"대상 멤버가 해당 그룹에 속하지 않습니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |
| 404 | `"참조 세션을 찾을 수 없습니다"` |

---

### GET /api/groups/:id/feedbacks

그룹 피드백 목록 조회.

| 항목 | 내용 |
| --- | --- |
| **Method** | `GET` |
| **Path** | `/api/groups/:id/feedbacks` |
| **인증** | **필요** |

**Path Parameters**

| 이름 | 설명 |
| --- | --- |
| `id` | 그룹 UUID |

**Query Parameters**

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `target_member_id` | N | 특정 멤버 필터 (`OWNER`/`MANAGER` 전용) |
| `page` | N | 페이지 번호 (기본 1) |
| `limit` | N | 페이지 크기 (기본 20) |

**Request Body**

없음

**Response `200`**

```json
{
  "success": true,
  "data": {
    "feedbacks": [
      {
        "feedback_id": "uuid",
        "target_member_id": "uuid",
        "target_user": {
          "user_id": "uuid",
          "nickname": "study_user"
        },
        "manager_member_id": "uuid",
        "manager_user": {
          "user_id": "uuid",
          "nickname": "group_owner"
        },
        "session_id": "uuid",
        "content": "오늘 집중도가 좋았습니다.",
        "created_at": "2026-06-27T11:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5
    }
  },
  "error": ""
}
```

**접근 제어 (`group_members.group_role`)**

| 역할 | 조회 범위 |
| --- | --- |
| `OWNER`, `MANAGER` | 그룹 내 전체 피드백 조회. `target_member_id` 필터 사용 가능 |
| `MEMBER` | **본인이 `target_member_id`인 피드백만** 조회 |
| 비구성원 | **403** |

**에러 케이스**

| 상태 | error 예시 |
| --- | --- |
| 401 | `"인증 토큰이 필요합니다"` |
| 403 | `"그룹 구성원만 피드백을 조회할 수 있습니다"` |
| 403 | `"다른 구성원의 피드백을 조회할 권한이 없습니다"` |
| 404 | `"그룹을 찾을 수 없습니다"` |

---

## 12. 부록

### 12.1 MVP 엔드포인트 목록

| Method | Path | 인증 |
| --- | --- | --- |
| POST | `/api/auth/register` | X |
| POST | `/api/auth/login` | X |
| POST | `/api/auth/logout` | O |
| POST | `/api/sessions/start` | O |
| POST | `/api/sessions/:id/log` | O |
| POST | `/api/sessions/:id/end` | O |
| GET | `/api/sessions` | O |
| GET | `/api/sessions/:id` | O |
| GET | `/api/reports/:session_id` | O |
| GET | `/api/reports/weekly` | O |
| GET | `/api/reports/monthly` | O |
| GET | `/api/users/:id/profile` | O |
| PATCH | `/api/users/me/profile` | O |
| GET | `/api/users/me/privacy` | O |
| PATCH | `/api/users/me/privacy` | O |
| POST | `/api/connections/request` | O |
| PATCH | `/api/connections/:id` | O |
| GET | `/api/connections` | O |
| POST | `/api/session-shares` | O |
| GET | `/api/session-shares/feed` | O |
| POST | `/api/session-shares/:id/reactions` | O |
| DELETE | `/api/session-shares/:id/reactions/:reactionType` | O |
| GET | `/api/rankings` | O |
| GET | `/api/groups` | O |
| POST | `/api/groups` | O |
| POST | `/api/groups/join` | O |
| GET | `/api/groups/:id` | O |
| POST | `/api/groups/:id/invite` | O |
| PATCH | `/api/groups/:id/members/:memberId` | O |
| DELETE | `/api/groups/:id/members/:memberId` | O |
| GET | `/api/groups/:id/dashboard` | O |
| POST | `/api/groups/:id/goals` | O |
| GET | `/api/groups/:id/goals` | O |
| POST | `/api/groups/:id/goals/:goalId/assignees` | O |
| POST | `/api/groups/:id/feedbacks` | O |
| GET | `/api/groups/:id/feedbacks` | O |

### 12.2 그룹 API 권한 매트릭스

| API | OWNER | MANAGER | MEMBER | 비구성원 |
| --- | --- | --- | --- | --- |
| POST `/groups` | — (생성 시 OWNER 부여) | — | — | O (생성 가능) |
| GET `/groups` | 본인 가입 목록 | 본인 가입 목록 | 본인 가입 목록 | 빈 목록 |
| POST `/groups/join` | 초대 대상이면 O | 초대 대상이면 O | 초대 대상이면 O | 초대 대상이면 O |
| GET `/groups/:id` (PRIVATE) | O | O | O | X |
| GET `/groups/:id` (PUBLIC) | O | O | O | O |
| POST `/groups/:id/invite` | O | O | X | X |
| PATCH `/groups/:id/members/:memberId` | O | X | X | X |
| DELETE `/groups/:id/members/:memberId` | O | 제한적 O | X | X |
| GET `/groups/:id/dashboard` | 전체 | 전체 | 본인 | X |
| POST `/groups/:id/goals` | O | O | X | X |
| GET `/groups/:id/goals` | O | O | O | X |
| POST `/groups/:id/goals/:goalId/assignees` | O | O | X | X |
| POST `/groups/:id/feedbacks` | O | O | X | X |
| GET `/groups/:id/feedbacks` | 전체 | 전체 | 본인 대상만 | X |

> 모든 권한 판단은 JWT `sub` → `group_members` 조회 → `group_role` + `status=ACTIVE` 기준.

### 12.3 조회용 View 참조

| View | 사용 API |
| --- | --- |
| `v_session_share_reaction_counts` | GET `/api/session-shares/feed` |
| `v_user_session_summaries` | GET `/api/session-shares/feed`, GET `/api/sessions` |
| `v_rankings` | GET `/api/rankings` |
| `v_group_member_stats` | GET `/api/groups/:id/dashboard` |
