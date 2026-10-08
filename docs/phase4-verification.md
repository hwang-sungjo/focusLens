# FocusLens Phase 4 최종 검증 기록

> 검증일: 2026-10-06  
> 대상: 백엔드 Phase 4-1 ~ 4-5 최종 게이트

## 1. 자동 검증

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 단위·컨트롤러 테스트 | `npm test -- --runInBand` | Jest 12 suite, 73 test 통과 |
| Prisma 스키마 | `prisma format`, `prisma validate` | 통과 |
| OpenAPI·Express 대조 | `npm run verify:openapi` | YAML 파싱, operationId 중복, responses, Express 라우트 36개 일치 |
| 정적 구문·diff | `node --check`, `git diff --check` | 통과 |
| 변경 범위 | `git diff --name-only -- ai frontend` | 변경 없음 |

`backend/scripts/verify-openapi-routes.js`는 8개 Express 라우터에서 HTTP method와 path를 읽어 `docs/swagger.yaml`과 양방향으로 비교한다. API를 추가하거나 제거할 때 둘 중 한쪽만 수정하면 실패한다.

## 2. 마이그레이션 검증

### 빈 DB

PostgreSQL 16의 빈 `focuslens_phase4_empty` DB에 저장소의 마이그레이션 10개를 `prisma migrate deploy`로 처음부터 적용했다. 오류 없이 완료됐고 Phase 4-5의 핵심 부분·복합 인덱스가 생성됐다.

### 기존 데이터 DB

개발 DB를 덤프로 복제한 `focuslens_phase4_existing`에서 검증했다. 적용 전 사용자 16행과 세션 11행이 있었고, 미적용 상태였던 다음 마이그레이션이 순서대로 적용됐다.

- `20261002000000_align_report_query_consistency`
- `20261005000000_add_concentration_rollups`
- `20261006000000_optimize_query_paths`

적용 후 사용자 16행과 세션 11행이 유지됐으며 조회 View 5개와 확인 대상 핵심 인덱스 3개가 존재했다. `prisma migrate status`는 `Database schema is up to date`를 반환했다.

로컬 개발 DB에는 이전 개발 과정에서 사용한 `20260928000000_add_idempotent_ai_log_contract`, `20260929000000_phase4_query_indexes` 이력이 남아 있다. 이 두 이름은 현재 저장소 마이그레이션 디렉터리에 없지만 Prisma 상태 검사와 이후 배포를 막지 않았다. 신규 환경과 Phase 5 배포 DB는 현재 저장소의 10개 마이그레이션을 기준으로 생성한다.

## 3. 실제 API 통합 검증

최신 백엔드를 별도 포트에서 실행하고 복제 PostgreSQL DB와 실제 Redis에 연결했다.

1. `GET /health` → DB·Redis `connected`, 200, 요청 ID 유지, 운영 카운터 반환
2. `POST /api/auth/register` → 사용자와 기본 프로필·프라이버시 생성, JWT 발급
3. `POST /api/sessions/start` → 진행 세션 생성
4. `POST /api/sessions/:id/log` → 집중도 80점 저장
5. 같은 로그 재전송 → 같은 `log_id`로 200
6. 같은 분 구간의 다른 로그 → 409
7. `POST /api/sessions/:id/end` → 세션 완료와 리포트 생성
8. `GET /api/reports/:session_id` → 평균 집중도 80 일치
9. `GET /api/sessions?page=1&limit=20` → 완료 세션 조회
10. `POST /api/auth/logout` 후 같은 JWT 재사용 → Redis 블랙리스트로 401

통합 로그 점검 중 Express 마운트 경로가 생략되고 메트릭 라벨이 `/`로 기록되는 문제를 발견했다. 구조화 로그는 query string을 제거한 전체 `originalUrl` 경로를 기록하고, 메트릭은 UUID 경로 구간을 `:id`로 바꾸도록 수정했다. 재검증에서 로그는 `/api/sessions/{실제 UUID}/log`, 메트릭 라벨은 `/api/sessions`처럼 기록됐다.

## 4. Phase 4 이후 외부 연동

Phase 5를 제외한 외부 연동 분류와 우선순위는 `docs/integration-readiness.md`를 따른다.

다음 항목은 백엔드 Phase 4 완료 범위 밖이며 준비되는 시점에 통합한다.

- AI 카메라 측정, 사용자별 보정, 1분 집계 정확도
- AI 오프라인 큐, 원래 측정 시각, 클라이언트 요청 ID, JWT 갱신
- 제품 프런트엔드 로그인·세션·리포트 E2E와 브라우저 출력 이스케이프
