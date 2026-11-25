# FocusLens 백엔드 성능·운영 기준

> 검증일: 2026-10-06
> 기준 구현: Phase 4-5

## 1. 성능 시나리오와 허용 기준

임시 PostgreSQL 16 DB에 사용자 1,001명, 세션 10,010개, 집중도 로그 100,100개, 공유 5,000개, 그룹 구성원 1,001명, 피드백 5,000개를 생성하고 `ANALYZE` 후 측정했다.

| 구분 | 허용 기준 | 측정 결과 | 주요 계획 |
| --- | --- | --- | --- |
| 세션 목록 20건 | DB 100ms 미만 | 0.248ms | `sessions_user_id_started_at_idx` Bitmap Index Scan |
| 세션 타임라인 100건 이하 | DB 100ms 미만 | 0.030ms | `concentration_logs_session_id_logged_at_idx` Index Scan |
| 공개 피드 20건 | DB 100ms 미만 | 0.220ms | `session_shares_active_created_at_id_idx` Index Scan |
| 주간 집중도 랭킹 | DB 200ms 미만 | 64.676ms | 로그 병렬 집계, 메모리 HashAggregate/Sort |
| 그룹 멤버 페이지 20건 | DB 100ms 미만 | 0.022ms | `group_members_group_status_role_joined_id_idx` Index Scan |
| 그룹 20명 세션 200건 | DB 100ms 미만 | 0.098ms | 사용자 세션 Bitmap Index Scan |
| 그룹 20명 통합 지표 | DB 200ms 미만 | 2.183ms | 세션별 로그 UNIQUE Index Scan |

실제 컨트롤러 호출 기준으로 피드 20/5,000건, 친구와 대기 요청 각 20/1,000건, 랭킹 상위 50명과 본인 순위, 그룹 대시보드 20/1,001명이 정상 반환됐다. 그룹 대시보드는 76ms, 친구 목록은 53ms, 랭킹은 69ms였다. 이 수치는 로컬 개발 환경의 회귀 기준이며 운영 환경에서는 p95를 별도로 수집한다.

## 2. 쿼리 수와 N+1 점검

조회 경로는 페이지 크기에 관계없이 고정된 수의 쿼리를 실행한다.

| API | 쿼리 구조 | N+1 결과 |
| --- | --- | --- |
| 세션 목록 | 세션 페이지+COUNT 트랜잭션, 세션 지표 View 1회 | 없음 |
| 공유 피드 | 친구/그룹 문맥, 피드 페이지+COUNT, 지표·반응·공통 그룹 일괄 조회 | 없음 |
| 랭킹 | 범위 사용자 조회 후 CTE+Window 함수 1회 | 없음 |
| 그룹 대시보드 | 권한 2회, 멤버 페이지+COUNT, 해당 사용자 세션, 지표 View | 없음 |
| 친구 목록 | 친구 페이지+COUNT, 선택 시 받은/보낸 요청 페이지+COUNT | 없음 |

루프 안에서 DB를 호출하지 않는다. Prisma 관계 조회는 페이지 단위 `include`/`select`로 일괄 실행한다. 그룹 대시보드는 전체 `v_group_member_stats`를 먼저 계산하지 않고, 현재 페이지 구성원의 세션 ID만 `v_session_metric_totals`에 전달한다.

## 3. 페이지와 응답 크기

| API | 기본/최대 | 안정 정렬 |
| --- | --- | --- |
| `GET /api/sessions` | 20/100 | `started_at DESC, id DESC` |
| `GET /api/session-shares/feed` | 20/100 | `created_at DESC, id DESC` |
| `GET /api/connections` | 20/100 | `created_at DESC, id DESC` |
| `GET /api/groups` | 20/100 | `joined_at DESC, id DESC` |
| `GET /api/groups/:id/dashboard` | 20/100 | `group_role, joined_at, id` |
| `GET /api/groups/:id/goals` | 20/100 | `created_at DESC, id DESC` |
| `GET /api/groups/:id/feedbacks` | 20/100 | `created_at DESC, id DESC` |

랭킹은 SQL에서 전체 순위를 산출한 뒤 상위 50명과 요청자 본인 한 행만 반환한다. 주간·월간 리포트는 임의 기간을 받지 않고 각각 7개·30개 UTC 날짜로 고정하여 응답 크기를 제한한다.

## 4. 구조화 로그

모든 HTTP 응답 완료 시 한 줄 JSON 로그를 기록한다.

| 필드 | 내용 |
| --- | --- |
| `timestamp`, `level`, `event` | ISO 시각, 심각도, `http_request` 등 이벤트 이름 |
| `request_id` | 안전한 `X-Request-ID`를 재사용하거나 UUID 생성 |
| `user_id` | 인증 완료 후 JWT `sub`, 비인증 요청은 `null` |
| `method`, `path`, `status_code` | 요청과 응답 정보. Query string과 토큰은 기록하지 않음 |
| `duration_ms` | 응답 완료까지의 밀리초 |

응답에도 `X-Request-ID`를 포함한다. 애플리케이션 오류, Redis 연결, Roll-up 성공·실패도 같은 JSON 이벤트 형식을 사용한다. 운영 500 오류 로그에는 내부 SQL이나 오류 메시지를 포함하지 않는다.

## 5. 운영 메트릭

프로세스 내 누적 카운터는 `/health`의 `data.metrics`에 노출되며 운영 수집기는 다음 이름을 수집한다.

| 메트릭 | 발생 조건 |
| --- | --- |
| `http_requests_total{method,status}` | 모든 HTTP 응답 |
| `auth_failures_total{route}` | 401 응답 |
| `permission_denials_total{route}` | 403 응답 |
| `http_server_errors_total{route}` | 5xx 응답 |
| `database_errors_total{code}` | Prisma `Pxxxx` 오류 |
| `redis_connection_errors_total{phase}` | Redis 실행 중 오류 또는 재시도 소진 |
| `dependency_health_failures_total{db,redis}` | `/health`가 degraded인 경우 |
| `rollup_runs_total{result}` | Roll-up 성공 또는 실패 |

동적 UUID는 메트릭 라벨에 넣지 않고 Express 라우트 패턴(예: `/api/sessions/:id`)으로 정규화한다. 카운터는 프로세스 재시작 시 초기화된다. Phase 5에서는 CloudWatch 또는 선택한 모니터링 시스템이 JSON 로그와 카운터를 외부 저장소로 수집하고 알림을 구성한다.

## 6. Redis 장애 계약

- 보호 API의 JWT 블랙리스트 조회 실패: fail-closed **503**.
- 로그아웃 시 블랙리스트 등록 실패: **503**이며 성공 응답을 반환하지 않는다.
- `/health` Redis ping 실패: **503**, `status=degraded`, `redis=disconnected`.
- DB는 연결됐어도 Redis가 끊긴 동안 보호 API는 사용할 수 없다. 공개 문서와 Health check는 서버 프로세스가 응답 가능한 범위에서 유지된다.
- Redis는 최대 2초 간격으로 계속 재연결한다. 인증 명령의 오프라인 큐를 끄고 명령 제한을 1.5초로 설정해 장애 중 요청을 나중에 실행하지 않는다. 같은 데이터를 유지한 Redis가 돌아오면 API 프로세스 재시작 없이 복구한다.

## 7. 로컬 장애 복구와 종료

PostgreSQL 연결 단절·연결 시간 초과·연결 풀 대기 시간 초과는 503과 `데이터베이스에 일시적으로 연결할 수 없습니다.`를 반환한다. 일반 SQL 오류는 500을 유지한다. DB·Redis 정상 여부는 `/health`의 `data.db`·`data.redis`로 구분한다. 같은 볼륨으로 의존성을 재기동한 뒤 `/health`가 200으로 돌아오고 기존 리포트가 조회되는지 확인한다.

SIGINT·SIGTERM을 받으면 HTTP 신규 접수를 중단하고 Roll-up의 다음 예약을 취소한다. 진행 중 HTTP 요청과 Roll-up이 끝난 뒤 Prisma와 Redis 연결을 닫는다. Redis `quit`이 실패하면 `disconnect`로 정리한다. 정상 종료 코드는 0이며, 기본 8초(`SHUTDOWN_TIMEOUT_MS`) 안에 끝나지 않으면 남은 소켓·연결을 강제 종료하고 코드 1로 끝낸다. Docker 종료 유예 시간은 이 값보다 길게 설정한다.

종료 로그는 `server_shutdown_started`, 자원별 `server_shutdown_resource_closed`(`http`, `rollup_scheduler`, `postgres`, `redis`), `server_shutdown_completed` 순으로 확인한다. 시간 초과는 `server_shutdown_timeout`, 정리 오류는 `server_shutdown_error`에 기록하며 비밀값과 원래 예외 메시지는 출력하지 않는다.

### Redis 데이터 유실 시 인증 복구

블랙리스트가 유실되면 서명이 유효한 과거 Access Token이 다시 허용될 수 있으므로 **Redis를 초기화·교체·유실된 상태로 복구하기 전에 API부터 중지**한다. 단순 재연결과 달리 다음 유지보수 절차는 모든 사용자의 재로그인을 요구한다.

```bash
docker compose stop --timeout 15 backend
# API를 중지한 상태에서 Redis 데이터·볼륨을 점검하거나 복구한다.
npm run local:recover-auth
curl --fail http://localhost:3000/health
```

`local:recover-auth`는 API 중지를 확인한 뒤 기존 환경 파일의 JWT 비밀값만 원자적으로 교체하고, PostgreSQL의 모든 Refresh Token을 폐기한다. DB·Redis 준비 후 API를 재생성한다. 기존 Access Token은 서명 검증 401, 기존 Refresh Token도 401이 되고 새 로그인부터 사용할 수 있다. 계정·세션·리포트는 유지한다. 단계를 완료하지 못하면 API를 중지 상태로 유지하며 같은 명령으로 복구를 다시 시도한다. Docker 자체 오류로 중지 상태를 확인하지 못하면 명령의 오류 안내에 따라 API가 계속 중지되어 있는지 확인한다.

이 절차는 Compose 로컬 환경과 기존 `backend/.env` 또는 `LOCAL_ENV_FILE`을 대상으로 한다. 별도 프로젝트를 사용하면 기존과 같은 `COMPOSE_PROJECT_NAME`을 전달한다. 동일 저장소의 동시 복구는 `.auth-recovery.lock`으로 차단한다. 작업 프로세스가 강제 종료되어 락이 남았다면, 기록된 PID의 복구 작업이 끝났고 API도 중지됐는지 확인한 뒤 남은 락을 정리하고 재실행한다. 비밀값 교체 후 과거 환경 파일로 되돌리지 않는다.

실행 중 예고 없이 발생한 `FLUSHDB`의 자동 감지·차단은 구현 범위에 포함하지 않는다. Redis 데이터 유실이 의심되면 API부터 중지하고 위 절차를 수행한다. `npm run verify:recovery`는 별도 Compose 프로젝트에서 실제 의존성 중단·복구, 유지보수 중 Redis 데이터 초기화와 토큰 무효화, 정상·의존성 단절 상태의 종료를 검증한다. 기존 서비스에는 장애를 주입하지 않는다.
