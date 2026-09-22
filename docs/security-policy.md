# FocusLens API 보안 검증 정책

> **기준 문서**: `docs/erd.md`, `docs/api-spec.md`, `docs/auth-flow.md`  
> **응답 형식**: `{ success: false, data: {}, error: "..." }`
> **공통 원칙**: 검증 실패 시 **400 / 403** 응답. 구조화된 실패 로그(user_id, path, reason)는 Phase 4 점검 대상

> **현재 로그 API 구현**: `backend/src/routes/sessions.js`에서 점수와 선택적 `face_detected`를 검증하고, `backend/src/controllers/sessionsController.js`에서 소유권·가중 합산값·Redis 60초 제한을 확인한다. `ai/`의 실시간 측정은 아직 이 API에 연결되지 않았다. ①·③은 현행 동작을 기술하며, 다른 절의 파일별 예시는 향후 분리 가능한 설계안이다.

---

## 1. 정책 요약

| # | 검증 항목 | 주요 대상 API | 실패 코드 |
| --- | --- | --- | --- |
| ① | gaze/blink/head/total: 0~100 float | `POST /api/sessions/:id/log` | **400** |
| ② | session_id 소유자 = JWT `sub` | 세션·리포트·로그 API | **403** |
| ③ | 1분 미만 중복 전송 차단 | `POST /api/sessions/:id/log` | **400** |
| ④ | HTTPS 전송 강제 | 전체 API (배포 환경) | **301** / 연결 거부 |
| ⑤ | `group_members.group_role` 권한 | 그룹 API 전반 | **403** |
| ⑥ | `default_session_scope` 초과 공개 차단 | `POST /api/session-shares`, `GET /api/session-shares/feed` | **403** |

---

## 2. 미들웨어 vs 컨트롤러 역할

```
요청
  → [④ HTTPS] (배포 시 인프라 구성)
  → [auth] JWT 검증 (401)
  → [sessions route] ① 점수·face_detected 검증 (400) — 로그 라우트
  → [sessions controller] ② 소유자·상태·total 검증 (403/409/400)
  → [Redis] ③ 세션별 60초 중복 전송 차단 (400)
  → [controller] DB 저장 및 응답
```

| 레이어 | 현재 파일 | 담당 정책 |
| --- | --- | --- |
| 미들웨어 | `backend/src/middleware/auth.js` | JWT (선행 조건) |
| 라우트 | `backend/src/routes/sessions.js` | ① 점수·`face_detected` 형식 |
| 컨트롤러 | `backend/src/controllers/sessionsController.js` | ② 소유권, ① `total` 일치, ③ 잠금 호출 |
| 서비스 | `backend/src/services/redis.js` | ③ 60초 중복 전송 차단 |

④ HTTPS 배포 구성과 ⑤·⑥ 정책은 각 절 및 `docs/backend-plan.md`의 별도 구현·검증 범위를 따른다.

---

## 3. 정책 상세

### ① gaze / blink / head / total: 0~100 범위 float 검증

ERD: `concentration_logs` — `gaze_score`, `blink_score`, `head_score`, `focus_score` (PostgreSQL CHECK와 앱 미들웨어에서 이중 검증)

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | `backend/src/routes/sessions.js` 입력 검증 + `backend/src/controllers/sessionsController.js`의 가중 합산값 확인 |
| **적용 라우트** | `POST /api/sessions/:id/log` |
| **실패 응답** | **400** — `"gaze, blink, head, total은 0~100 범위의 float여야 합니다"` |

**현행 구현**

1. `gaze`, `blink`, `head`, `total` 각각 `number`, 유한값, 0~100 범위를 확인한다. 문자열 숫자는 거부한다.
2. `face_detected`는 선택적 boolean이며 생략 시 현재 컨트롤러는 `true`로 저장한다.
3. 서버가 0.4/0.3/0.3 가중 합산값을 계산하고 요청의 `total`과 차이가 0.01을 넘으면 400을 반환한다. DB에는 서버 계산값을 저장한다.
4. AI 측 1분 점수·분 단위 `face_detected` 산출은 아직 미구현이므로 실제 자동 전송 검증은 후속 통합 작업이다.

---

### ② session_id 소유자 = JWT sub 매칭

ERD: `sessions.user_id`(FK) — 세션 소유자. JWT `sub` = `users.id`.

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | `backend/src/controllers/sessionsController.js`, `reportsController.js`, `sessionSharesController.js` |
| **적용 라우트** | `POST /api/sessions/:id/log`, `POST /api/sessions/:id/end`, `GET /api/sessions/:id`, `GET /api/reports/:session_id`, `POST /api/session-shares` (body `session_id`) |
| **실패 응답** | **403** — `"해당 세션에 대한 권한이 없습니다"` |
| **세션 없음** | **404** — `"세션을 찾을 수 없습니다"` |

**현행 구현**

1. JWT 미들웨어 이후 `req.user.sub` 사용.
2. 각 컨트롤러에서 `sessions`를 조회하고 `session.user_id`와 `sub`를 비교한다.
3. 레코드 없음 → 404 vs 403 구분: id 자체가 없으면 404, id는 있으나 `user_id ≠ sub`이면 403.
4. `POST /api/session-shares`는 path가 아닌 body `session_id` → 공유 컨트롤러에서 동일 조건 적용.
5. **`sessions.user_id`를 Request Body로 받지 않음** — api-spec: user_id는 JWT에서만 추출.

---

### ③ 1분 미만 중복 전송 차단

ERD: `concentration_logs` — **UNIQUE(`session_id`, `logged_at`)**

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | `backend/src/services/redis.js`의 `SET NX` 잠금 + 세션 컨트롤러 |
| **적용 라우트** | `POST /api/sessions/:id/log` |
| **실패 응답** | **400** — `"1분 미만 중복 로그 전송입니다"` |
| **DB 제약** | `(session_id, logged_at)` UNIQUE는 존재하지만 현재 중복 요청의 주된 차단 수단은 Redis 60초 잠금 |

**현행 구현**

1. `session-log-rate:{sessionId}` 키를 Redis `SET NX EX 60`으로 획득한다. 실패 시 400을 반환한다.
2. `logged_at`은 서버 수신 시각 `new Date()`로 저장하며 분 단위로 절삭하지 않는다.
3. DB INSERT 실패 시 Redis 잠금을 해제한다. 재전송 큐를 구현할 때는 원래 측정 시각과 중복 처리 정책을 별도로 확정해야 한다.

---

### ④ HTTPS 전송 강제 (배포 시)

현재 저장소에는 nginx 설정과 `requireHttps` 미들웨어가 없다. 아래는 Phase 5 배포 설계이며 현행 로컬 API 동작이 아니다.

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | **인프라** nginx (1차) + **미들웨어** `requireHttps` (2차, 선택) |
| **적용 범위** | 프로덕션·스테이징 전체 API |
| **실패 응답** | **301** Redirect → `https://` (nginx) / **403** `"HTTPS required"` (Express fallback) |
| **로컬 개발** | `NODE_ENV=development` — 검증 **비활성화** |

**구현 방향**

**1) nginx (권장, 1차)**

```nginx
server {
  listen 80;
  server_name api.focuslens.example;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  # ssl_certificate ...
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**2) Express 미들웨어 (2차)**

```javascript
// src/middleware/requireHttps.js — production only
function requireHttps(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto !== 'https') {
    return res.status(403).json({ success: false, data: {}, error: 'HTTPS required' });
  }
  next();
}
```

3. `app.set('trust proxy', 1)` — EC2/nginx 뒤에서 `X-Forwarded-Proto` 신뢰.
4. HSTS 헤더 추가 권장: `Strict-Transport-Security: max-age=31536000`.

---

### ⑤ 그룹 권한: group_members.group_role 기준

ERD: `group_members.group_role` (`OWNER` / `MANAGER` / `MEMBER`).  
**금지**: `groups.created_by_user_id` 단독으로 OWNER/MANAGER 판단.

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | `backend/src/controllers/groupsController.js`의 활성 멤버·역할 검사, 그룹 랭킹은 `rankingsController.js` |
| **적용 라우트** | `/api/groups/:id/*` (생성 제외), `/api/rankings?scope=group` |
| **실패 응답** | **403** — API별 메시지 (예: `"그룹 초대 권한이 없습니다 (OWNER 또는 MANAGER 필요)"`) |
| **비구성원** | **403** — `"그룹 구성원만 …"` / `"해당 그룹의 구성원이 아닙니다"` |

**현행 구현 원칙**

1. JWT `sub` → `group_members` 조회:

```sql
SELECT id, group_role, status
FROM group_members
WHERE group_id = :groupId
  AND user_id = :sub
  AND status = 'ACTIVE';
```

2. 그룹 자체가 없으면 **404**, 그룹은 있으나 활성 멤버가 아니면 **403**.
3. 컨트롤러의 `hasRole` 검사에서 필요한 `group_role` 미충족 → **403**.
4. **`groups.created_by_user_id === sub`이어도** `group_role ≠ OWNER`면 거부.
5. 컨트롤러에서 조회한 `group_members.id`를 `created_by_member_id`, `manager_member_id` 등에 사용한다.
6. 그룹 **생성**(`POST /api/groups`): 트랜잭션 내 `groups` INSERT + `group_members` INSERT (`group_role=OWNER`).

**역할별 API 매핑**

| group_role | 예시 허용 API |
| --- | --- |
| `OWNER` | 멤버 역할 변경, 초대, 목표, 피드백, 전체 피드백 조회 |
| `MANAGER` | 초대, 목표, 피드백 (역할 변경 불가) |
| `MEMBER` | 목표 목록 조회, 본인 대상 피드백만 조회 |

---

### ⑥ 세션 공유: default_session_scope 초과 공개 차단

ERD: `user_privacy_settings.default_session_scope` — `PUBLIC` | `FRIENDS` | `GROUP` | `PRIVATE`

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | `backend/src/controllers/sessionSharesController.js` (공유 **생성**·**조회** 모두) |
| **적용 라우트** | `POST /api/session-shares`, `GET /api/session-shares/feed` |
| **실패 응답 (생성)** | **403** — `"프라이버시 설정(default_session_scope)보다 넓은 범위로 공유할 수 없습니다"` |
| **실패 응답 (조회)** | 해당 항목 **제외** (403 전체 거부 아님) 또는 접근 불가 share → **403** (단건 조회 시) |

**공개 범위 순위 (좁음 → 넓음)**

| 순위 | scope | 설명 |
| --- | --- | --- |
| 0 | `PRIVATE` | 외부 공유 불가 |
| 1 | `FRIENDS` | 친구에게만 |
| 2 | `GROUP` | 지정 그룹 |
| 3 | `PUBLIC` | 전체 공개 |

**구현 방향 — 공유 생성 (`POST /api/session-shares`)**

1. ② 선행: `sessions.user_id = JWT sub` 확인.
2. `user_privacy_settings` WHERE `user_id = sub` 조회.
3. `share_scope` 순위 > `default_session_scope` 순위 → **403**.
4. `default_session_scope = PRIVATE` → 모든 `share_scope` 공유 **403**.
5. `share_scope = GROUP` → `group_id` 필수 + 요청자 `group_members` ACTIVE 확인.

```javascript
const SCOPE_RANK = { PRIVATE: 0, FRIENDS: 1, GROUP: 2, PUBLIC: 3 };

function assertShareAllowed(defaultScope, requestedScope) {
  if (SCOPE_RANK[requestedScope] > SCOPE_RANK[defaultScope]) {
    throw forbidden('프라이버시 설정(default_session_scope)보다 넓은 범위로 공유할 수 없습니다');
  }
}
```

**구현 방향 — 공유 조회 (`GET /api/session-shares/feed`)**

1. 피드 쿼리 시 **세션 소유자**의 `user_privacy_settings` JOIN.
2. `session_shares.share_scope` 순위 > 소유자 `default_session_scope` → **결과에서 제외** (설정 변경 후 기존 share 무효화).
3. **조회자** 관점 접근 제어:
   - `PUBLIC`: 모두
   - `FRIENDS`: `user_connections` 친구 관계
   - `GROUP`: `group_members` 공통 그룹
4. `score_visibility`, `study_time_visibility`에 따라 응답 필드 마스킹 (api-spec).
5. `session_shares.deleted_at IS NULL AND status = ACTIVE` 필터.

```javascript
// 피드 SQL 개념
WHERE ss.deleted_at IS NULL
  AND ss.status = 'ACTIVE'
  AND scope_rank(ss.share_scope) <= scope_rank(ups.default_session_scope)
  AND viewer_can_access(ss, :viewerId)
```

---

## 4. 정책별 요청 처리 순서 (집중도 로그 예시)

`POST /api/sessions/:id/log` — ①②③이 모두 적용되는 대표 케이스:

```
1. [④] HTTPS (Phase 5 배포 시 구성)
2. [auth] JWT → req.user.sub
3. [sessions route] gaze/blink/head/total 0~100 및 face_detected 타입 → 400
4. [sessions controller] 세션 존재·소유자·진행 상태 및 total 가중 합산값 확인
5. [Redis] 동일 세션 60초 잠금 SET NX, 실패 시 400
6. [sessions controller] 서버 수신 시각으로 concentration_logs INSERT
7. 200 응답
```

---

## 5. 로깅 및 테스트

### 실패 로그 필드

아래 구조화 로그 필드는 Phase 4 목표다. 현재 오류 처리기는 `console.error`로 오류 스택 또는 메시지를 출력하며 이 필드들을 별도로 기록하지 않는다.

| 필드 | 예시 |
| --- | --- |
| `policy_id` | `"①"` ~ `"⑥"` |
| `user_id` | JWT `sub` |
| `method`, `path` | `POST /api/sessions/:id/log` |
| `reason` | 검증 실패 사유 |

### 단위·통합 테스트 (Phase 4)

| # | 테스트 케이스 |
| --- | --- |
| ① | `-1`, `101`, `"80"`, `NaN` → 400 |
| ② | 타인 `session_id` → 403 |
| ③ | 동일 세션에서 60초 미만 2회 POST → 400 |
| ④ | `X-Forwarded-Proto: http` (prod) → 403 |
| ⑤ | MEMBER가 invite 시도 → 403; `created_by_user_id`만 일치 + role MEMBER → 403 |
| ⑥ | `default_session_scope=PRIVATE` + `share_scope=PUBLIC` → 403; feed에서 scope 초과 share 미노출 |

---

## 6. 구현 체크리스트

- [✅] `backend/src/routes/sessions.js` + `backend/src/controllers/sessionsController.js` — ① 점수·`face_detected` 형식과 가중 합산값 검증
- [✅] `backend/src/services/redis.js` — ③ 세션별 60초 중복 전송 차단
- [✅] 세션·리포트·공유 컨트롤러 — ② 소유자 검증 (별도 `sessionOwner.js` 없음)
- [✅] 그룹·랭킹 컨트롤러 — ⑤ 활성 `group_members` 및 역할 검증 (별도 `groupAuth.js` 없음)
- [✅] 공유 컨트롤러 — ⑥ scope 순위 비교 및 조회 제한 (별도 `privacyService.js` 없음)
- [✅] `backend/src/middleware/errorHandler.js` — 일반 Prisma `P2002`를 409로 응답
- [ ] Phase 4 — ①②③⑤⑥ 우회 시나리오·구조화 실패 로그 검증
- [ ] Phase 5 — nginx HTTPS 구성과 필요 시 Express 보조 검사
