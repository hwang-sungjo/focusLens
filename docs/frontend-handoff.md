# FocusLens 로컬 프런트 인계

> 기준일: 2026-11-26 · 범위: LBE-5 백엔드 인계
> API 상세: [API 명세](api-spec.md), [화면별 매핑](frontend-api-map.md)
> 전체 진행: [백엔드 계획](backend-plan.md), AI 실행: [로컬 실행 가이드](setting-guide.md)

이번 실행 검증은 작업 브랜치 `develop@9e462a8`의 회원가입·로그인·대시보드·세션·리포트·프로필 화면을 기준으로 한다. 원격 `origin/main@40bc369`에는 PR #11의 피드·랭킹·친구·그룹 목록·상세와 인증·프로필·리포트 개선이 이미 합쳐져 있지만 현재 작업 트리에는 아직 반영되지 않았다. 이 비교는 로컬 Git 객체를 읽어 확인했으며 브랜치 병합이나 프런트 소스 교체는 수행하지 않았다.

백엔드 인계는 로컬 실행 주소, 인증·권한·프라이버시 계약과 재검증 절차를 제공한다. 다음 제품 통합은 최신 main 프런트를 동기화하고 기존 기능을 보존해 실제 API·AI 결과를 연결하는 작업이다.

## 1. 실행 주소와 명령

Node.js 22.x(22.13 이상)와 Docker Desktop이 필요하다. 명령은 저장소 루트에서 실행한다.

```bash
npm ci --prefix backend
npm run local:up
npm run local:seed
npm ci --prefix frontend
npm --prefix frontend run dev -- --host localhost --port 5173 --strictPort
```

`local:up`은 기존 환경 파일을 보존하고 DB·Redis 준비, 저장소 migration·조회 View 적용 후 API를 시작한다. `local:seed`는 선택적 테스트 계정 생성이며 기존 비밀번호·프로필을 초기화하지 않는다. `strictPort`는 5173이 사용 중일 때 5174로 자동 변경되는 것을 막는다.

| 대상 | 로컬 값 |
| --- | --- |
| 프런트 | `http://localhost:5173` |
| API | `http://localhost:3000` |
| Swagger | `http://localhost:3000/api-docs/` |
| Health | `http://localhost:3000/health` — DB·Redis 정상 시 200 |
| 프런트 API 설정 | `frontend/.env.development`의 `VITE_API_BASE_URL=http://localhost:3000`; 없으면 같은 기본값 |
| Compose CORS 설정 | `LOCAL_CORS_ORIGIN=http://localhost:5173` |
| 호스트에서 직접 API 실행 시 CORS | `backend/.env`의 `CORS_ORIGIN=http://localhost:5173` |

프런트와 API의 호스트 이름은 모두 `localhost`로 맞춘다. `localhost`와 `127.0.0.1`을 섞으면 SameSite 쿠키 전달과 CORS가 달라질 수 있다. 별도 포트를 쓸 때는 `LOCAL_API_PORT`, `VITE_API_BASE_URL`, `LOCAL_CORS_ORIGIN`을 함께 맞추고 API 컨테이너와 Vite를 다시 시작한다. Compose에서는 `backend/.env`의 CORS 값보다 `LOCAL_CORS_ORIGIN` 설정이 우선한다.

종료는 `npm run local:down`이며 볼륨을 유지한다. 기존 데이터 변경 전 `npm run local:backup`을 사용한다. 일상 기동·환경 맞춤에 `db:reset`이나 `docker compose down -v`를 사용하지 않는다.

## 2. 테스트 계정과 계정 분리

| 이메일 | 최초 시드 비밀번호 | 용도 |
| --- | --- | --- |
| `user_a@focuslens.dev` | `password_a123!` | 일반 사용자 A |
| `user_b@focuslens.dev` | `password_b123!` | 일반 사용자 B, 시드에서 A와 친구 |
| `admin@focuslens.dev` | `password_admin123!` | 전역 ADMIN, 시드 스터디 그룹의 OWNER |

기존 계정의 비밀번호·관계·역할을 바꾼 환경에서는 변경한 값을 사용한다. 시드는 과거 상태를 강제로 되돌리지 않는다. 전역 `users.role=ADMIN`이 모든 그룹의 관리 권한을 뜻하지 않는다. 각 그룹 권한은 활성 `group_members.group_role`로 판단한다.

다중 계정은 별도 브라우저 프로필·시크릿 컨텍스트로 나눠 로그인한다. 같은 브라우저 컨텍스트의 탭은 `localStorage`와 Refresh 쿠키를 공유한다. 같은 컨텍스트에서 계정을 번갈아 바꾸며 동시에 사용하는 동작은 이번 인계의 보장 범위가 아니다.

## 3. 인증과 오류 계약

프런트 `src/api.ts`는 Access Token을 `localStorage`에 저장하고 `Authorization: Bearer`로 보낸다. 요청에는 `credentials: 'include'`를 사용한다. 로컬 Refresh 쿠키는 `HttpOnly`, `SameSite=Lax`, host-only, `Path=/api/auth`이며 HTTP 로컬 환경에서는 Secure를 요구하지 않는다. Refresh Token을 프런트 저장소에 복사하지 않는다.

보호 요청 401은 쿠키로 Refresh를 한 번 시도하고 원 요청을 한 번 재시도한다. 같은 페이지에서 동시에 들어온 갱신 요청은 하나의 Promise를 공유한다. 갱신 실패 시 로컬 인증을 지우고 `/login?expired=true`로 이동한다. 로그인·가입·로그아웃은 이 자동 갱신을 건너뛴다. 회원가입 성공 후 로그인 화면으로 이동하는 현재 UX를 유지한다.

위 실패 처리는 이번에 실행한 develop 클라이언트 기준이다. 원격 main 클라이언트는 Refresh의 429·5xx·네트워크 오류에서 인증을 유지하고, 무효 Refresh인 경우만 재로그인한다. 최신 main을 동기화한 뒤 이 개선 동작을 브라우저에서 재검증한다. 로그아웃은 body의 Refresh Token을 우선하고 없으면 쿠키를 사용해 해당 family를 폐기한다. body와 쿠키 모두 없을 때만 해당 사용자의 모든 활성 Refresh Token을 폐기한다.

| 상태 | 처리 기준 |
| --- | --- |
| 400 | 입력값·점수·요청 조건 오류를 수정한다. |
| 401 | 보호 요청은 Refresh 1회 후 재시도, 갱신 실패 시 재로그인한다. |
| 403 | 인증은 유지하고 권한 부족을 안내한다. |
| 404 | 없거나 조회할 수 없는 리소스임을 안내한다. |
| 409 | 이미 진행 중인 세션·분 구간 충돌·중복 상태를 확인한다. |
| 500 | 일반 오류와 `X-Request-ID`를 보여준다. |
| 503 | 의존성 장애 안내와 수동 재시도를 제공한다. Refresh 자체가 실패하면 현재 클라이언트는 재로그인으로 이동한다. |

응답은 `{ success, data, error }` 형식이다. API는 `X-Request-ID`를 노출하므로 프런트 오류 문구와 서버 로그를 대조할 수 있다. 429의 `Retry-After`·자동 backoff는 현재 AI 전송 계약이며 웹 공통 클라이언트는 별도의 자동 재시도를 하지 않는다.

## 4. 권한과 공개 범위

| 흐름 | 백엔드 기준 |
| --- | --- |
| 세션 로그·종료·상세·리포트 | `sessions.user_id`와 JWT `sub`가 같은 소유자만 접근; 다른 사용자는 403 |
| 그룹 초대·목표 생성·목표 배정·피드백 작성 | 해당 그룹의 활성 OWNER 또는 MANAGER |
| 그룹 멤버 역할 변경 | 해당 그룹의 활성 OWNER |
| 그룹 대시보드 | OWNER·MANAGER는 `all_members`, MEMBER는 `self`; 비구성원은 403 |
| 피드백 조회 | OWNER·MANAGER는 그룹 범위, MEMBER는 본인 수신분 |
| 세션 공유 | 완료된 소유 세션이며 `default_session_scope`를 초과하지 않는 범위만 허용 |
| 피드의 점수·시간 | 공유 접근과 `score_visibility`·`study_time_visibility`를 각각 적용해 `null`로 가림 |
| 그룹 통계 | `group_data_sharing` 설정을 준수 |
| 랭킹 | `ranking_participation=false` 사용자는 제외 |

프라이버시 enum은 `PUBLIC`, `FRIENDS`, `GROUP`, `PRIVATE`이며 GET과 PATCH에서 같은 값을 쓴다. boolean 필드는 `group_data_sharing`, `ranking_participation`이다. 작업 브랜치의 프로필 화면은 기본 세션 공개·점수 공개·그룹 공유·랭킹 참여를 편집한다. 여기서는 `study_time_visibility`를 응답에서 보존하지만 편집 컨트롤은 없다. 원격 main에는 학습 시간 공개 범위 편집이 이미 추가돼 있다.

`avg_focus_score`, `duration_seconds` 등의 `null`은 0으로 변환하지 않는다. 무기록과 비공개를 다른 API를 조합해 복원하지 않는다. 그룹 관리 버튼의 표시 여부와 관계없이 서버의 403을 최종 판단으로 삼는다. 그룹 생성자 ID 또는 전역 ADMIN만으로 권한을 추론하지 않는다.

## 5. AI 도구와 세션 화면의 현재 경계

`SessionPage.tsx`는 현재 임의 점수를 60초마다 v1 API로 보낸다. 가중치는 `gaze × 0.3 + blink × 0.5 + head × 0.2`이며 실제 AI 분석 결과가 아니다. 브라우저 카메라는 화면 미리보기로만 사용한다. `local:ai`는 Python 카메라·보정·실제 집계와 영속 큐를 사용해 v2로 전송한다.

**같은 계정에서 `local:ai` 측정 중 프런트 세션의 이어하기·종료하기를 실행하지 않는다.** 이어하기는 같은 세션에 더미 v1 로그를 섞어 분 구간 409를 일으킬 수 있고, 프런트 종료는 CLI 미전송 큐가 비워지기 전에 세션을 닫을 수 있다. 프런트 카메라와 Python 카메라를 동시에 열지 않는다. AI 도구에서 전송·종료를 마친 뒤 같은 계정의 리포트·대시보드에서 결과를 조회한다.

프런트 통합의 다음 단위는 다음 세 가지다.

1. 최신 main의 기존 프런트 기능을 동기화하고 인증·프로필·리포트·소셜·그룹의 실제 API 흐름을 검증한다. 이미 있는 화면을 다시 구현하지 않는다. main README의 추가 API 제안은 별도 후속 요구사항으로 검토한다.
2. 기존 화면·알림 동작을 유지하면서 실제 AI 점수·상태의 수신 위치와 세션 제어 주체를 연결한다. 더미와 실제 로그를 동시에 보내지 않는다. `SessionPage`는 두 브랜치에서 동일하므로 위 동시 조작 경계가 계속 적용된다.
3. 브라우저에서 로그인→실제 측정→대기 로그 복구→종료→리포트까지 종합 E2E와 반응형·접근성·출력 이스케이프를 검증한다.

## 6. 재검증

```bash
npm run verify:handoff
npm run verify:local
npm run verify:openapi
npm --prefix frontend run build
npm --prefix frontend run lint
```

`verify:handoff`는 다중 계정·그룹 역할·공개 범위와 로컬 인증 인계 계약을 확인한다. 기존 AI 검증은 `verify:ai1`, `verify:ai2:focus:fixture`, `verify:ai3`를 사용한다. `verify:local-ai`는 카메라 준비 후 실행하는 실제 2분 측정이며 검증 계정·세션을 만든다. 실행 환경과 상세 절차는 [로컬 실행 가이드](setting-guide.md)를 따른다.

| 이번 인계 검증 | 상태 |
| --- | --- |
| CORS·쿠키·다중 계정·그룹·프라이버시 실제 API 검증 | 격리 PostgreSQL·Redis·API에서 109개 요청 통과, migration 11개·View 5개·시드 확인, 검증 자원 정리 완료 |
| 프런트 잠금 의존성 설치 후 build·lint | `npm ci --prefix frontend` 후 두 명령 모두 통과; manifest·lock·프런트 기능 소스 변경 없음 |
| 실제 브라우저 | Chrome 시크릿에서 localhost:5173 로그인→dashboard 이동 확인. 전용 브라우저 연결 호스트를 사용할 수 없고 네이티브 제어 대상이 바뀌어 쿠키 재발급·화면 종합 검증은 완료하지 못함 |

HTTP 검증은 세 일반 계정과 전역 ADMIN을 분리해 쿠키·Refresh·로그아웃, 소유권 403, 친구·공유·반응·공개 범위 축소, 실제 경과 시간 마스킹, 그룹 동의·역할 이양·생성자 권한 감소·ADMIN 우회 차단을 확인했다. 임의 점수 로그와 세션 시각 소급은 사용하지 않았다. 점수 마스킹은 빈 세션의 null 계약만 확인했으며 실제 비영점 점수 마스킹의 HTTP 실증으로 해석하지 않는다. Node 쿠키 저장소 테스트는 브라우저의 SameSite 정책 검증을 대체하지 않는다.

프런트 설치 시 npm 감사는 13개 항목(중간 9·높음 4), 백엔드 production 이미지 빌드는 3개(중간 1·높음 1·치명적 1)를 보고했다. 의존성 버전과 잠금 파일은 유지했으며 취약 경로·실행 영향과 업데이트는 별도 유지보수에서 확인한다. 이번 로컬 인계를 배포 보안 검증 완료로 해석하지 않는다.

이 표와 [백엔드 계획](backend-plan.md)의 LBE-5 기록은 최종 실행 증거로 갱신한다. LBE-5 인계 완료와 실제 AI·프런트·백엔드의 제품 전체 통합 완료를 구분한다.
