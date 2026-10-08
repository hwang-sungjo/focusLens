# FocusLens 클라이언트 연동 계약 결정

> 확정일: 2026-10-06  
> 범위: Phase 5 제외, AI·프런트 연동을 위한 선행 결정  
> 구현 상태: 계약 확정 및 백엔드 구현·fixture/HTTP 통합 검증 완료

## 1. 호환성 원칙

- 현재 38개 API와 `POST /api/sessions/:id/log` v1 동작을 유지한다.
- AI와 프런트가 준비되기 전에는 기존 요청·응답을 파괴적으로 변경하지 않는다.
- 새 로그 필드와 Refresh Token은 기존 v1을 유지한 별도 경로와 저장 구조로 추가했다.
- 로그 v1 제거 시점은 AI v2 E2E 통과와 명시적 사용 중단 확인 이후로 제한한다.

## 2. 집중도 로그 v2

### 결정

지연 재전송의 원래 분 구간을 복원하기 위해 로그 v2를 도입했다. 구현 endpoint는 다음과 같다.

```http
POST /api/v2/sessions/{session_id}/log
Authorization: Bearer {access_token}
Content-Type: application/json
```

```json
{
  "client_log_id": "uuid-v4",
  "measured_at": "2026-10-06T06:01:00.000Z",
  "gaze": 85.5,
  "blink": 72.0,
  "head": 90.0,
  "total": 82.8,
  "face_detected": true
}
```

| 필드 | 규칙 |
| --- | --- |
| `client_log_id` | 클라이언트가 1분 구간마다 생성하는 UUID v4. 재시도 동안 변경 금지 |
| `measured_at` | 해당 60초 측정 구간의 종료 시각. UTC RFC 3339 형식 |
| 점수 4개 | 유한한 0~100 숫자. `total = gaze×0.3 + blink×0.5 + head×0.2` |
| `face_detected` | 필수 boolean. `false`이면 점수 4개 모두 0 |

### 서버 처리 규칙

1. JWT `sub`와 세션 소유자가 일치하고 세션이 `IN_PROGRESS`인지 확인한다.
2. `measured_at`은 `started_at + 60초` 이상이어야 하며 서버 시각보다 최대 5분 미래까지만 허용한다.
3. `minute_index = floor((measured_at - started_at) / 60초)`로 계산한다.
4. `(session_id, client_log_id)`와 `(session_id, minute_index)`를 각각 UNIQUE로 보호한다.
5. 같은 `client_log_id`와 같은 정규화 payload 재전송은 기존 로그를 200으로 반환한다.
6. 같은 `client_log_id`의 다른 payload 또는 같은 분 구간의 다른 ID는 409를 반환한다.
7. `logged_at`은 최초 서버 수신 시각, `measured_at`은 클라이언트 측 측정 구간 종료 시각으로 구분한다.
8. 대기 로그는 세션 종료 전에 모두 전송한다. 세션 종료 후 늦은 로그를 받아 리포트를 변경하는 기능은 도입하지 않는다.

### v1과 v2 관계

| 구분 | v1 | v2 |
| --- | --- | --- |
| 경로 | `/api/sessions/:id/log` | `/api/v2/sessions/:id/log` |
| 분 구간 기준 | 서버 수신 시각 | `measured_at` |
| 재시도 식별자 | 없음 | `client_log_id` |
| 현재 구현 | ✅ | ✅ |

## 3. 장시간 세션 인증

### 결정

- Access Token 만료는 현재와 같이 1시간을 유지한다.
- 장시간 AI 세션을 위해 회전형 Refresh Token을 도입한다.
- Refresh Token 기본 만료는 30일로 한다.
- Refresh Token은 256bit 이상의 불투명 난수이며 DB에는 SHA-256 해시만 저장한다.
- 갱신 때마다 기존 토큰을 폐기하고 새 Refresh Token으로 교체한다.
- 이미 교체된 토큰이 다시 사용되면 같은 token family를 모두 폐기한다.
- 로그아웃은 현재 Access Token 블랙리스트 등록과 함께 해당 Refresh Token family를 폐기한다.

구현 endpoint:

```http
POST /api/auth/refresh
```

성공 시 새 Access Token과 회전된 Refresh Token을 반환한다. AI는 운영체제 보안 저장소를 사용하고, 제품 웹은 Secure·HttpOnly·SameSite 쿠키 사용을 기본으로 한다. 웹의 최종 cookie domain과 SameSite 값은 프런트 배포 주소가 정해질 때 확정한다.

현재 백엔드는 JSON body와 HttpOnly cookie 전달을 지원한다. Access Token 401 수신 시 갱신을 한 번 시도하고 실패하면 재로그인한다.

## 4. AI 전송 재시도

| 실패 유형 | 처리 |
| --- | --- |
| 네트워크 오류, timeout, 408 | 같은 `client_log_id`로 재시도 |
| 429 | `Retry-After` 우선, 없으면 backoff 적용 |
| 500·502·503·504 | 같은 ID로 재시도 |
| 401 | Refresh Token 갱신 1회 후 원 요청 1회 재시도. 실패하면 사용자 재인증 필요 |
| 400 | payload 오류로 분류하고 자동 재시도하지 않음 |
| 403·404 | 소유권·세션 오류로 분류하고 자동 재시도하지 않음 |
| 409 | 동일 ID 응답 내용을 확인하고 충돌이면 자동 재시도하지 않음 |

Backoff는 `1, 2, 4, 8, 16, 30초`를 상한으로 full jitter를 적용한다. 메모리 재시도는 최대 8회이며 이후에는 영속 큐에 보관한다. 세션 종료 요청은 대기 로그가 모두 성공하거나 복구 불가능 상태로 명시 처리된 뒤에만 보낸다.

## 5. AI 측정 인수 기준

| 영역 | 통과 기준 |
| --- | --- |
| 환경 | Python 3.11에서 AI pytest 전체 통과 |
| 보정 | 3초 동안 최소 20개의 유효 얼굴 sample로 gaze/head baseline 생성 |
| 1분 sample | 10 FPS 기준 600개 예상, 최소 480개 미만이면 해당 구간을 전송하지 않음 |
| 얼굴 검출 | 유효 sample 중 얼굴 검출 비율 80% 이상이면 `face_detected=true` |
| 얼굴 미검출 | 비율 80% 미만이면 `face_detected=false`, 점수 4개 모두 0 |
| blink | `OPEN→CLOSED→OPEN`만 1회 event. 100~500ms는 정상 blink, 1,000ms 이상은 장시간 눈 감김 |
| 점수 | `gaze/blink/head/total` 모두 유한한 0~100 값 |
| total | 백엔드 가중식 결과와 소수 둘째 자리 기준 0.01 이내 |
| 구간 | 완료된 60초마다 `MinuteScore` 최대 1개 생성 |
| 재시도 | 재시도 동안 `client_log_id`, `measured_at`, payload 불변 |
| E2E | 저장된 점수, 세션 종료 summary, 세션 리포트 값 일치 |

실제 카메라 환경의 정확도 목표는 기기·조명별 fixture를 확보한 뒤 별도 수치로 추가한다. 위 기준은 파이프라인 계약과 데이터 무결성의 최소 통과 기준이다.

## 6. 구현 결과

- `ai/`를 변경하지 않고 로그 v2와 Refresh Token을 구현했다.
- Prisma migration, API 명세, OpenAPI, 단위 테스트와 실제 PostgreSQL·Redis HTTP 흐름을 검증했다.
- 현행 v1 로그는 호환 유지하며 장시간 세션 클라이언트는 Refresh Token 연동을 사용할 수 있다.
