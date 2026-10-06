# FocusLens API 보안 검증 정책

> **기준 문서**: `docs/erd.md`, `docs/api-spec.md`, `docs/auth-flow.md`  
> **응답 형식**: `{ success: false, data: {}, error: "..." }`
> **공통 원칙**: 실패 원인에 따라 **400 / 401 / 403 / 404 / 409 / 503**을 구분한다. Phase 4-5에서 요청 ID 기반 구조화 로그와 실패 카운터를 구현했다.

> **현재 로그 API 구현**: `backend/src/routes/sessions.js`에서 점수와 필수 `face_detected`를 검증한다. `backend/src/controllers/sessionsController.js`는 소유권·세션 상태·가중 합산값·얼굴 미검출 0점 규칙을 검사하고, 서버가 계산한 분 구간을 DB UNIQUE 제약과 Serializable 트랜잭션으로 멱등 저장한다.

---

## 1. 정책 요약

| # | 검증 항목 | 주요 대상 API | 실패 코드 |
| --- | --- | --- | --- |
| ① | gaze/blink/head/total: 0~100 float | `POST /api/sessions/:id/log` | **400** |
| ② | session_id 소유자 = JWT `sub` | 세션·리포트·로그 API | **403** |
| ③ | 분 구간 멱등 저장과 내용 충돌 차단 | `POST /api/sessions/:id/log` | **409** |
| ④ | HTTPS 전송 강제 | 전체 API (배포 환경) | **301** / 연결 거부 |
| ⑤ | `group_members.group_role` 권한 | 그룹 API 전반 | **403** |
| ⑥ | `default_session_scope` 초과 공개 차단 | `POST /api/session-shares`, `GET /api/session-shares/feed` | **403** |

### JWT와 Redis 장애 정책

- 보호 라우트는 Bearer JWT의 서명과 만료를 검증한 뒤 Redis 블랙리스트를 조회한다.
- 토큰 없음·만료·변조·로그아웃 토큰은 401을 반환한다.
- Redis에서 로그아웃 여부를 확인할 수 없으면 요청을 통과시키지 않고 503 `"인증 상태를 확인할 수 없습니다."`를 반환한다.
- 알 수 없는 서버 오류의 응답에는 실행 환경과 관계없이 내부 예외 메시지, 스택, SQL, 토큰, 비밀번호 해시를 넣지 않는다.

---

## 2. 미들웨어 vs 컨트롤러 역할

```
요청
  → [④ HTTPS] (배포 시 인프라 구성)
  → [auth] JWT 검증 (401)
  → [sessions route] ① 점수·face_detected 검증 (400) — 로그 라우트
  → [sessions controller] ② 소유자·상태·total·미검출 0점 검증 (403/409/400)
  → [sessions controller] 서버 수신 시각으로 minute_index 계산 (400)
  → [PostgreSQL] ③ (session_id, minute_index) UNIQUE와 Serializable 트랜잭션
  → [controller] 동일 내용 200 / 다른 내용 409
```

| 레이어 | 현재 파일 | 담당 정책 |
| --- | --- | --- |
| 미들웨어 | `backend/src/middleware/auth.js` | JWT (선행 조건) |
| 라우트 | `backend/src/routes/sessions.js` | ① 점수·`face_detected` 형식 |
| 컨트롤러 | `backend/src/controllers/sessionsController.js` | ② 소유권·상태, ① 점수 규칙, ③ 분 구간 계산·멱등 판정 |
| 데이터베이스 | `concentration_logs` UNIQUE 제약 | ③ 동시 요청을 포함한 구간당 한 행 보장 |

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
2. `face_detected`는 필수 boolean이다. `false`이면 네 점수가 모두 정확히 0이어야 한다.
3. 서버는 세부 점수를 소수 둘째 자리로 정규화한 뒤 0.4/0.3/0.3 가중 합산값을 계산한다.
4. 요청의 `total`과 계산값 차이가 0.01을 넘으면 400을 반환하고 DB에는 서버 계산값을 저장한다.

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

### ③ 분 구간 멱등 저장과 내용 충돌 차단

ERD: `concentration_logs` — **UNIQUE(`session_id`, `minute_index`)**

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | 세션 컨트롤러 + PostgreSQL UNIQUE 제약 |
| **적용 라우트** | `POST /api/sessions/:id/log` |
| **동일 내용** | **200** — 기존 로그의 동일한 `log_id` 반환 |
| **다른 내용** | **409** — `"같은 분 구간에 다른 로그가 이미 존재합니다"` |
| **DB 제약** | `(session_id, minute_index)` UNIQUE + `minute_index >= 1` CHECK |

**현행 구현**

1. `minute_index = floor((서버 수신 시각 - sessions.started_at) / 60초)`로 계산한다. 경과 시간이 60초 미만이면 400을 반환한다.
2. 기존 행이 있으면 소수 둘째 자리로 정규화한 `gaze`, `blink`, `head`, 서버 계산 `total`, `face_detected`를 비교한다.
3. 동일 내용은 기존 행을 반환하고 다른 내용은 409를 반환한다.
4. 동시 INSERT는 DB UNIQUE 제약이 한 건만 허용한다. 동일 내용으로 충돌한 요청은 생성된 행을 조회해 200을 반환한다.
5. 로그 저장과 세션 종료는 Serializable 트랜잭션으로 실행하고 직렬화 충돌을 재시도한다. 재시도 시 세션이 종료됐으면 409를 반환한다.
6. `logged_at`은 최초 저장 요청의 서버 수신 시각이다. 현재 요청에는 원래 측정 시각과 클라이언트 요청 ID가 없으므로 한 구간 이상 지연된 재전송의 원래 구간은 복원할 수 없다.

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
3. [sessions route] gaze/blink/head/total 0~100 및 필수 face_detected 타입 → 400
4. [sessions controller] 얼굴 미검출 0점, 세션 존재·소유자·진행 상태, total 가중 합산값 확인
5. [sessions controller] 세션 시작 시각과 서버 수신 시각으로 minute_index 계산
6. [PostgreSQL] Serializable 트랜잭션과 (session_id, minute_index) UNIQUE로 멱등 저장
7. 동일 내용은 기존 로그 200, 다른 내용은 409
```

---

## 5. 로깅 및 테스트

### 구조화 로그와 운영 카운터

`requestContext`가 모든 응답 완료 시 JSON 한 줄을 기록하고 응답에 `X-Request-ID`를 넣는다. 클라이언트 요청 ID는 허용 문자와 길이를 검증한 뒤 사용한다.

| 필드 | 예시 |
| --- | --- |
| `request_id` | 검증된 요청 ID 또는 서버 UUID |
| `user_id` | JWT `sub` |
| `method`, `path` | `POST /api/sessions/:id/log` |
| `status_code`, `duration_ms` | 응답 코드와 처리 시간 |

401·403·5xx, Prisma 오류, Redis 연결 오류, 의존성 Health 실패, Roll-up 성공·실패는 프로세스 카운터로 누적해 `/health`의 `data.metrics`에서 확인한다. 메트릭 경로 라벨은 동적 UUID를 제외한 Express 라우트 패턴으로 정규화한다. 운영 로그에는 Authorization 헤더, JWT, 비밀번호 해시, SQL과 500 오류의 내부 메시지를 기록하지 않는다. 상세 필드와 장애 계약은 `docs/performance-operations.md`를 따른다.

### 단위·통합 테스트 (Phase 4)

| # | 테스트 케이스 |
| --- | --- |
| ① | `-1`, `101`, `"80"`, `NaN` → 400 |
| ② | 타인 `session_id` → 403 |
| ③ | 같은 분 구간·동일 내용 2회 POST → 같은 `log_id`로 200; 다른 내용 → 409; 동시 요청 → DB 한 행 |
| ④ | `X-Forwarded-Proto: http` (prod) → 403 |
| ⑤ | MEMBER가 invite 시도 → 403; `created_by_user_id`만 일치 + role MEMBER → 403 |
| ⑥ | `default_session_scope=PRIVATE` + `share_scope=PUBLIC` → 403; feed에서 scope 초과 share 미노출 |

### Phase 4-2 검증 결과 (2026-10-02)

- Jest 9 suite·54 test 통과.
- OpenAPI에 Bearer 인증이 명시된 34개 operation의 무토큰 요청이 모두 401을 반환했다.
- 만료·변조·로그아웃 토큰은 401, Redis 조회 실패는 503으로 차단됨을 확인했다.
- 세션·리포트 교차 사용자 접근, 그룹 역할, 생성자 비권한, 공유 범위와 필드별 공개 설정을 검증했다.
- 친구 요청·공감·그룹 초대·세션 시작 동시 요청에서 한 건만 생성되고 나머지는 409를 반환했다.
- SQL Injection과 저장형 XSS 형태 문자열은 실행되지 않고 문자열 그대로 저장·반환됐다. 화면 출력 시 이스케이프 책임은 제품 프런트엔드에 있다.
- 500 응답은 모든 환경에서 일반 메시지만 반환하도록 고정했다. 상세 오류는 서버 로그에서만 확인한다.

---

## 6. 구현 체크리스트

- [✅] `backend/src/routes/sessions.js` + `backend/src/controllers/sessionsController.js` — ① 점수·필수 `face_detected`·미검출 0점과 가중 합산값 검증
- [✅] Prisma 스키마·마이그레이션 + 세션 컨트롤러 — ③ 서버 산출 분 구간과 DB 멱등 저장
- [✅] 세션·리포트·공유 컨트롤러 — ② 소유자 검증 (별도 `sessionOwner.js` 없음)
- [✅] 그룹·랭킹 컨트롤러 — ⑤ 활성 `group_members` 및 역할 검증 (별도 `groupAuth.js` 없음)
- [✅] 공유 컨트롤러 — ⑥ scope 순위 비교 및 조회 제한 (별도 `privacyService.js` 없음)
- [✅] `backend/src/middleware/errorHandler.js` — 일반 Prisma `P2002`를 409로 응답
- [✅] Phase 4-1 — ①·③ 로그 규칙과 동시 멱등 저장 단위·실제 API 검증
- [✅] Phase 4-2 — 인증, ②⑤⑥ 권한·프라이버시, 동시 충돌, 입력 문자열, 오류 노출 검증
- [✅] Phase 4-5 — 요청 ID·사용자·경로·상태·처리 시간 구조화 로그와 실패 카운터 검증
- [ ] Phase 5 — nginx HTTPS 구성과 필요 시 Express 보조 검사
