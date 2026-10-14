# FocusLens Roll-up 운영 전략

> 구현 기준일: 2026-10-05
> 구현 위치: `backend/src/services/rollup.js`, `backend/src/services/rollupScheduler.js`
> 목적: 분 단위 로그를 단계적으로 압축하면서 API 통계와 접근 권한을 유지한다.

## 1. 보관 계층

| 소스 | 대상 | 보관 전환 기준 | 버킷 |
| --- | --- | --- | --- |
| `concentration_logs` | `hourly_stats` | 30일 | UTC 시간 |
| `hourly_stats` | `daily_stats` | 90일 | UTC 일 |
| `daily_stats` | `weekly_stats` | 365일 | UTC 월요일 시작 주 |

기준 시각이 걸친 버킷은 처리하지 않는다. 실행 시각에서 보관 일수를 뺀 후 각각 시간, 일, 주 시작으로 내림한 UTC cutoff보다 이른 행만 처리한다.

소셜 데이터, 세션, 리포트는 Roll-up 대상이 아니다. `session_shares`와 `session_reactions`는 이 잡에서 삭제하지 않는다.

## 2. 집계 스키마

`hourly_stats`, `daily_stats`, `weekly_stats`는 다음 값을 공통으로 보존한다.

| 컬럼 | 의미 |
| --- | --- |
| `session_id`, `bucket_start` | 세션과 UTC 버킷. 두 컬럼에 UNIQUE 적용 |
| `avg_gaze_score`, `avg_blink_score`, `avg_head_score`, `avg_focus_score` | `log_count` 가중 평균 |
| `log_count` | 최하위 원본 로그 수 |
| `focused_count`, `normal_count`, `distracted_count` | 상태별 원본 로그 수 |
| `face_not_detected_count` | 얼굴 미검출 원본 로그 수 |

상위 tier 평균은 하위 평균의 단순 평균이 아니라 `SUM(avg_score × log_count) / SUM(log_count)`로 계산한다. DB CHECK 제약은 점수 0~100, 양수 `log_count`, 상태 건수 합과 `log_count`의 일치를 강제한다.

## 3. 트랜잭션과 멱등성

각 단계는 별도 Serializable 트랜잭션에서 다음 순서로 실행한다.

1. PostgreSQL advisory transaction lock으로 Roll-up 잡의 동시 실행을 직렬화한다.
2. cutoff 이전 소스를 버킷별로 집계한다.
3. `(session_id, bucket_start)` 충돌 시 모든 집계 값을 갱신하는 UPSERT를 실행한다.
4. 대상의 평균, 원본 로그 수, 상태 건수, 얼굴 미검출 건수를 소스 집계와 비교한다.
5. 검증된 경우에만 같은 cutoff의 소스 행을 삭제한다.
6. 실제 삭제 행 수가 대상 소스 행 수와 다르면 예외를 발생시켜 전체 단계를 롤백한다.

한 단계가 실패하면 이후 단계는 실행하지 않는다. 실패한 단계의 집계와 삭제는 함께 롤백된다. 이미 처리된 범위를 다시 실행하면 대상 소스가 0건이므로 중복 행이 생기지 않는다.

## 4. 조회 경로

`v_session_metric_totals`가 다음 데이터를 `UNION ALL`한 뒤 세션별 가중 합계와 평균을 제공한다.

- `concentration_logs`
- `hourly_stats`
- `daily_stats`
- `weekly_stats`

세션 목록·상세, 기간 리포트, 공유 피드는 이 View를 읽는 `sessionStats` 서비스를 사용한다. `v_user_session_summaries`, `v_rankings`, `v_group_member_stats`도 같은 View를 사용한다. 프라이버시와 그룹 권한 조건은 기존 API 및 View에서 그대로 적용한다.

세션 상세와 세션 리포트의 `timeline`은 네 tier를 시간순으로 합친다.

| `granularity` | 원천 | 상세 필드 |
| --- | --- | --- |
| `MINUTE` | 원본 | `minute_index`, 상태, 얼굴 검출 여부 포함 |
| `HOUR` | 시간 집계 | 평균과 건수 제공 |
| `DAY` | 일 집계 | 평균과 건수 제공 |
| `WEEK` | 주 집계 | 평균과 건수 제공 |

집계 행은 여러 원본 로그를 나타내므로 `minute_index`, `attention_state`, `face_detected`가 `null`이고 `log_count`와 상태별 건수를 사용한다.

## 5. 실행 방법

### 수동 실행

```bash
npm run rollup
```

명령은 세 단계별 cutoff, 물리 소스 행 수, 보존한 원본 로그 수, 버킷 수, 삭제 행 수를 JSON으로 출력한다. 실패하면 종료 코드 1을 반환한다.

### 서버 스케줄러

```dotenv
ROLLUP_ENABLED=true
ROLLUP_SCHEDULE_HOUR_UTC=0
ROLLUP_RAW_RETENTION_DAYS=30
ROLLUP_HOURLY_RETENTION_DAYS=90
ROLLUP_DAILY_RETENTION_DAYS=365
```

`ROLLUP_ENABLED=true`인 서버 프로세스가 매일 지정 UTC 시각에 잡을 실행한다. 여러 인스턴스가 동시에 시작해도 DB advisory lock으로 트랜잭션이 직렬화된다. 운영 환경에서는 잡 성공·실패 로그와 각 단계의 삭제 행 수를 수집한다.

## 6. 검증 기준

- 빈 DB에 전체 Prisma migration이 적용된다.
- 40일, 100일, 400일 데이터가 각각 시간, 일, 주 tier에 남는다.
- 원본 삭제 전후 평균, 로그 수, 상태별 건수, 얼굴 미검출 건수가 같다.
- 세션, 랭킹, 그룹 통계와 프라이버시 결과가 같다.
- 두 번째 실행은 세 단계 모두 0건이고 집계 행 수가 변하지 않는다.
- 강제 INSERT 실패 시 원본은 남고 대상 집계는 생성되지 않는다.

2026-10-05 검증에서 7개 원본 로그를 시간 2건·일 3건·주 2건으로 이동한 뒤 위 통계가 모두 유지됐다. 재실행은 전 단계 0건이었고, 강제 DB 오류에서는 원본 1건 보존과 대상 0건을 확인했다.
