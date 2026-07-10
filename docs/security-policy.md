# FocusLens API 보안 검증 정책

> **기준 문서**: `docs/erd.md`, `docs/api-spec.md`, `docs/auth-flow.md`  
> **응답 형식**: `{ success: false, data: null, error: "..." }`  
> **공통 원칙**: 검증 실패 시 **400 / 403** 응답 + 서버 로그 기록 (user_id, path, reason)

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
  → [④ HTTPS] (인프라 / Express)
  → [auth] JWT 검증 (401)
  → [sessionOwner] ② 세션 소유 (403) — 세션 라우트
  → [groupAuth] ⑤ 그룹 역할 (403) — 그룹 라우트
  → [validateConcentrationLog] ① ③ — 로그 라우트
  → 컨트롤러 — ⑥ 프라이버시·비즈니스 로직
```

| 레이어 | 파일 (권장) | 담당 정책 |
| --- | --- | --- |
| 인프라 | `nginx.conf` | ④ |
| 미들웨어 | `src/middleware/auth.js` | JWT (선행 조건) |
| 미들웨어 | `src/middleware/sessionOwner.js` | ② |
| 미들웨어 | `src/middleware/groupAuth.js` | ⑤ |
| 미들웨어 | `src/middleware/validateConcentrationLog.js` | ①, ③ |
| 미들웨어 | `src/middleware/requireHttps.js` | ④ (Express 보조) |
| 컨트롤러 / 서비스 | `src/controllers/sessionShareController.js` | ⑥ |
| 컨트롤러 / 서비스 | `src/services/privacyService.js` | ⑥ |

---

## 3. 정책 상세

### ① gaze / blink / head / total: 0~100 범위 float 검증

ERD: `concentration_logs` — `gaze_score`, `blink_score`, `head_score`, `focus_score` (CHECK는 DB 미적용, 앱에서 검증)

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | **미들웨어** `validateConcentrationLog` (+ 유틸 `src/utils/focusScore.js`) |
| **적용 라우트** | `POST /api/sessions/:id/log` |
| **실패 응답** | **400** — `"gaze, blink, head, total은 0~100 범위의 float여야 합니다"` |

**구현 방향**

1. Request body 필드 `gaze`, `blink`, `head`, `total` 각각 `validateScore(value, fieldName)` 호출.
2. `typeof value === 'number'`, `!Number.isNaN(value)`, `0 <= value <= 100` 확인.
3. 문자열 `"85"` 등 암묵적 형변환 **허용하지 않음** (strict number).
4. 검증 통과 후 `total`을 `focus_score`로 DB 저장; `calculateFocusScore`·`getAttentionState`로 `attention_state` 산출.
5. `FocusScoreValidationError` catch → 400 + `logger.warn`.

```javascript
// src/middleware/validateConcentrationLog.js
const { validateScore, calculateFocusScore, getAttentionState } = require('../utils/focusScore');

function validateConcentrationLog(req, res, next) {
  try {
    const { gaze, blink, head, total } = req.body;
    validateScore(gaze, 'gaze');
    validateScore(blink, 'blink');
    validateScore(head, 'head');
    validateScore(total, 'total');
    req.concentrationPayload = {
      gaze_score: gaze,
      blink_score: blink,
      head_score: head,
      focus_score: total,
      attention_state: getAttentionState(total),
    };
    next();
  } catch (err) {
    return res.status(400).json({ success: false, data: null, error: err.message });
  }
}
```

---

### ② session_id 소유자 = JWT sub 매칭

ERD: `sessions.user_id`(FK) — 세션 소유자. JWT `sub` = `users.id`.

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | **미들웨어** `sessionOwner` (공통) + 필요 시 **컨트롤러**에서 `session_id` body 검증 |
| **적용 라우트** | `POST /api/sessions/:id/log`, `POST /api/sessions/:id/end`, `GET /api/sessions/:id`, `GET /api/reports/:session_id`, `POST /api/session-shares` (body `session_id`) |
| **실패 응답** | **403** — `"해당 세션에 대한 권한이 없습니다"` |
| **세션 없음** | **404** — `"세션을 찾을 수 없습니다"` |

**구현 방향**

1. JWT 미들웨어 이후 `req.user.sub` 사용.
2. `sessions` 조회: `WHERE id = :sessionId AND user_id = :sub`.
3. 레코드 없음 → 404 vs 403 구분: id 자체가 없으면 404, id는 있으나 `user_id ≠ sub`이면 403.
4. `POST /api/session-shares`는 path가 아닌 body `session_id` → 컨트롤러/서비스에서 동일 조건 적용.
5. **`sessions.user_id`를 Request Body로 받지 않음** — api-spec: user_id는 JWT에서만 추출.

```javascript
// src/middleware/sessionOwner.js
async function sessionOwner(req, res, next) {
  const sessionId = req.params.id || req.params.session_id;
  const session = await prisma.sessions.findUnique({ where: { id: sessionId } });
  if (!session) {
    return res.status(404).json({ success: false, data: null, error: '세션을 찾을 수 없습니다' });
  }
  if (session.user_id !== req.user.sub) {
    return res.status(403).json({ success: false, data: null, error: '해당 세션에 대한 권한이 없습니다' });
  }
  req.session = session;
  next();
}
```

---

### ③ 1분 미만 중복 전송 차단

ERD: `concentration_logs` — **UNIQUE(`session_id`, `logged_at`)**

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | **미들웨어** (사전 검사) + **컨트롤러** (INSERT 시 DB 제약 활용) |
| **적용 라우트** | `POST /api/sessions/:id/log` |
| **실패 응답** | **400** — `"1분 미만 중복 로그 전송입니다"` |
| **DB 충돌** | Prisma `P2002` → 동일 400 메시지로 매핑 |

**구현 방향**

1. **`logged_at` 정규화**: 서버 기준 `date_trunc('minute', NOW())` 또는 요청 시각을 분 단위로 floor.
2. **미들웨어 사전 검사**: 동일 `session_id` + `logged_at`(분) 레코드 EXISTS → 400 (DB round-trip 절약).
3. **INSERT**: `logged_at`을 분 단위로 저장해 UNIQUE 제약과 정합.
4. **Race condition**: 동시 요청 시 UNIQUE 위반(`P2002`) catch → 400 동일 메시지.
5. 1분 **미만**이 아니라 **동일 분** 중복 차단 — ERD `logged_at` 분 단위 타임라인과 일치.

```javascript
// logged_at: 분 단위 버킷
const loggedAt = startOfMinute(new Date());

const exists = await prisma.concentration_logs.findUnique({
  where: { session_id_logged_at: { session_id: sessionId, logged_at: loggedAt } },
});
if (exists) {
  return res.status(400).json({ success: false, data: null, error: '1분 미만 중복 로그 전송입니다' });
}
```

---

### ④ HTTPS 전송 강제 (배포 시)

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
    return res.status(403).json({ success: false, data: null, error: 'HTTPS required' });
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
| **검증 위치** | **미들웨어** `groupAuth(requiredRoles[])` |
| **적용 라우트** | `/api/groups/:id/*` (생성 제외), `/api/rankings?scope=group` |
| **실패 응답** | **403** — API별 메시지 (예: `"그룹 초대 권한이 없습니다 (OWNER 또는 MANAGER 필요)"`) |
| **비구성원** | **403** — `"그룹 구성원만 …"` / `"해당 그룹의 구성원이 아닙니다"` |

**구현 방향**

1. JWT `sub` → `group_members` 조회:

```sql
SELECT id, group_role, status
FROM group_members
WHERE group_id = :groupId
  AND user_id = :sub
  AND status = 'ACTIVE';
```

2. 레코드 없음 → **403** (404 아님 — 그룹 존재 여부 노출 최소화).
3. `requiredRoles` 배열과 `group_role` 교차 확인 — 미충족 → **403**.
4. **`groups.created_by_user_id === sub`이어도** `group_role ≠ OWNER`면 거부.
5. `req.groupMember = { id, group_role }` 바인딩 — `created_by_member_id`, `manager_member_id` 등에 `group_members.id` 사용.
6. 그룹 **생성**(`POST /api/groups`): 트랜잭션 내 `groups` INSERT + `group_members` INSERT (`group_role=OWNER`).

**역할별 API 매핑**

| group_role | 예시 허용 API |
| --- | --- |
| `OWNER` | 멤버 역할 변경, 초대, 목표, 피드백, 전체 피드백 조회 |
| `MANAGER` | 초대, 목표, 피드백 (역할 변경 불가) |
| `MEMBER` | 목표 목록 조회, 본인 대상 피드백만 조회 |

```javascript
// src/middleware/groupAuth.js
function groupAuth(...allowedRoles) {
  return async (req, res, next) => {
    const member = await prisma.group_members.findFirst({
      where: { group_id: req.params.id, user_id: req.user.sub, status: 'ACTIVE' },
    });
    if (!member || !allowedRoles.includes(member.group_role)) {
      return res.status(403).json({ success: false, data: null, error: '…' });
    }
    req.groupMember = member;
    next();
  };
}
```

---

### ⑥ 세션 공유: default_session_scope 초과 공개 차단

ERD: `user_privacy_settings.default_session_scope` — `PUBLIC` | `FRIENDS` | `GROUP` | `PRIVATE`

| 항목 | 내용 |
| --- | --- |
| **검증 위치** | **컨트롤러 / 서비스** `privacyService` (공유 **생성**·**조회** 모두) |
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
1. [④] HTTPS (production)
2. [auth] JWT → req.user.sub
3. [sessionOwner] sessions.user_id === sub → 403
4. [validateConcentrationLog] gaze/blink/head/total 0~100 → 400
5. [controller] logged_at 분 단위 + UNIQUE 사전검사 → 400
6. [controller] concentration_logs INSERT (UNIQUE DB fallback)
7. 200 응답
```

---

## 5. 로깅 및 테스트

### 실패 로그 필드

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
| ③ | 동일 분 2회 POST → 400 |
| ④ | `X-Forwarded-Proto: http` (prod) → 403 |
| ⑤ | MEMBER가 invite 시도 → 403; `created_by_user_id`만 일치 + role MEMBER → 403 |
| ⑥ | `default_session_scope=PRIVATE` + `share_scope=PUBLIC` → 403; feed에서 scope 초과 share 미노출 |

---

## 6. 구현 체크리스트

- [ ] `src/utils/focusScore.js` — ① 검증 재사용
- [ ] `src/middleware/validateConcentrationLog.js` — ①③
- [ ] `src/middleware/sessionOwner.js` — ②
- [ ] `src/middleware/groupAuth.js` — ⑤
- [ ] `src/services/privacyService.js` — ⑥ scope 순위 비교
- [ ] `src/middleware/requireHttps.js` + nginx 301 — ④
- [ ] 전역 에러 핸들러 — Prisma `P2002` → 400 (③)
- [ ] `groups.created_by_user_id` 권한 분기 **코드 리뷰 금지 패턴** 등록
