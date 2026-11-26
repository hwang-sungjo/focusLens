# FocusLens 로컬 실행 안내

저장소 루트에서 `npm run local:up`을 실행하면 로컬 PostgreSQL·Redis, 마이그레이션·조회 View, API를 순서대로 준비합니다. Node.js 22와 실행 중인 Docker Desktop(Docker Compose 포함)이 필요합니다.
프런트엔드 및 AI 개발자분들은 아래 가이드에 따라 로컬 개발 환경을 세팅해 주시기 바랍니다.

프런트 주소·쿠키·테스트 계정·권한·검증 결과는 [LBE-5 프런트 인계](frontend-handoff.md)를 기준으로 합니다. 현재 작업 develop과 원격 main의 프런트 차이도 이 문서에 기록했습니다.

현재 API는 38개 operation, Prisma 모델 20개, migration 11개, 조회 View 5개입니다. AI-1~3의 연결 모듈과 검증 절차는 `docs/backend-plan.md`에 기록돼 있습니다. 일반 로컬 서버의 지속 AI 실행은 아래 `local:ai` 명령을 사용합니다.

---

## 🛠️ 공통: 로컬 환경 세팅 방법

모든 팀원은 동일한 환경에서 개발을 진행하기 위해 아래 단계를 수행해야 합니다. (Docker Desktop 필수)

1. **한 번의 실행 명령**

   최초 실행 시 `backend/.env.local.example`을 바탕으로 `backend/.env`를 만들고 JWT 비밀값을 임의 생성합니다. 기존 파일이 있으면 내용과 비밀값을 보존합니다. 실제 환경변수 파일은 Git에 커밋하지 않습니다.

   ```bash
   npm run local:up
   ```

   최초 이미지 빌드는 인터넷에서 Node 이미지와 npm 패키지를 받습니다. 실행 이미지에는 Prisma Client·스키마·Swagger가 포함됩니다. DB·Redis 준비 후 저장소의 migration과 View를 적용하고, 이 단계가 성공한 뒤 API가 시작됩니다. 컨테이너 기동 시 Prisma 패키지를 내려받지 않습니다.

2. **실행 확인**
   ```bash
   curl http://localhost:3000/health
   # Swagger UI: http://localhost:3000/api-docs/
   ```

   기본 포트는 API 3000, PostgreSQL 5432, Redis 6379이며 호스트의 루프백 주소로만 공개합니다. 프런트엔드 개발 주소는 `http://localhost:5173`입니다. 로컬 HTTP에서는 HttpOnly·SameSite=Lax·host-only Refresh 쿠키를 사용합니다.

3. **로그·종료·코드 변경 적용**
   ```bash
   npm run local:logs
   npm run local:down
   npm run local:up
   ```

   `local:down`은 데이터를 보관하는 볼륨을 유지합니다. 소스가 이미지에 포함되므로 변경 후 `local:up`으로 다시 빌드합니다. 로컬 자동 Roll-up의 기본값은 꺼짐이며 `LOCAL_ROLLUP_ENABLED=true`로 켤 수 있습니다.

4. **새 환경 검증·계정**
   `npm run verify:local`은 별도 프로젝트·임시 포트·빈 볼륨으로 같은 실행 절차를 검증하고 종료 시 검증용 자원을 정리합니다. Health·Swagger·OpenAPI·CORS·회원가입·로그인·Refresh 쿠키와 migration 11개·View 5개를 대조합니다.

   새 환경에서는 회원가입으로 계정을 만듭니다. 테스트 계정이 필요하면 `local:up`이 성공한 뒤 `npm run local:seed`를 실행합니다. 아래 계정은 시드를 실행한 환경에만 존재합니다. 기존 계정의 비밀번호·프로필은 시드 재실행으로 덮어쓰지 않습니다. 기존 계정의 비밀번호를 바꾼 경우에는 변경한 비밀번호로 로그인합니다.
   - `user_a@focuslens.dev` / `password_a123!` (일반 유저)
   - `user_b@focuslens.dev` / `password_b123!` (일반 유저, A와 친구 관계)
   - `admin@focuslens.dev` / `password_admin123!` (관리자, 스터디 그룹 OWNER)

### 포트를 따로 사용하는 경우

기존 실행 환경과 나란히 쓰려면 프로젝트 이름과 공개 포트를 함께 지정합니다. 같은 설정을 종료할 때도 전달합니다.

```bash
COMPOSE_PROJECT_NAME=focuslens-local-new LOCAL_API_PORT=13000 LOCAL_DB_PORT=15432 LOCAL_REDIS_PORT=16379 npm run local:up
COMPOSE_PROJECT_NAME=focuslens-local-new LOCAL_API_PORT=13000 LOCAL_DB_PORT=15432 LOCAL_REDIS_PORT=16379 npm run local:down
```

이때 API 주소는 `http://localhost:13000`입니다. 프런트 주소가 바뀌면 `LOCAL_CORS_ORIGIN`을 지정합니다. 환경 파일 경로는 `LOCAL_ENV_FILE`로 따로 지정할 수 있습니다. 호스트에서 백엔드를 직접 실행할 때는 `backend/.env`의 DB·Redis 주소를 실제 호스트 포트에 맞춥니다.

### 기존 데이터 보관·백업·복원

`local:up`은 기존 볼륨에서 미적용 migration만 실행합니다. 저장소에 없는 과거 migration 이력도 삭제하지 않습니다. `local:down`으로 중지한 뒤 같은 프로젝트 이름으로 다시 실행하면 계정·세션·리포트를 유지합니다. 볼륨 삭제 옵션(`down -v`)과 `db:reset`은 데이터 보존 절차에 사용하지 않습니다.

기존 DB를 변경하기 전에 저장소 루트에서 백업합니다.

```bash
npm run local:backup
# 예전 고정 이름 컨테이너를 사용하는 경우
npm run local:backup -- --container focuslens_postgres
```

백업은 `backups/`에 PostgreSQL custom-format `.dump`로 저장하며, 명령이 경로·크기·SHA-256과 아카이브 목록 검증 결과를 출력합니다. `--output 경로` 또는 `LOCAL_BACKUP_DIR`로 위치를 바꿀 수 있습니다. 파일 권한은 소유자 읽기·쓰기로 제한하고 같은 이름의 기존 파일은 덮어쓰지 않습니다. DB 데이터가 담긴 `backups/`는 Git에서 제외합니다. 실제 복원 가능 여부는 아래 복원·통합 검증으로 확인합니다.

```bash
npm run local:restore -- --input backups/백업파일.dump
# 대상 이름을 지정해도 새 focuslens_restore_* DB만 생성할 수 있습니다.
npm run local:restore -- --input backups/백업파일.dump --database focuslens_restore_check
```

복원 명령은 실행 중인 로컬 PostgreSQL에 **별도 DB**를 만듭니다. 원래 `focuslens` DB와 실행 중인 API의 연결 대상은 바꾸지 않습니다. 같은 이름의 DB가 있으면 거절하며, 복원 중 실패한 새 DB는 확인할 수 있도록 유지합니다. `--container 이름`으로 기존 컨테이너를 선택할 수도 있습니다.

```bash
npm run verify:preserve -- --backup backups/백업파일.dump
```

통합 검증은 백업을 별도 Compose 프로젝트에 복원하고, migration 전후 기존 컬럼의 행 수·SHA-256, 시드 2회 실행, 볼륨 재시작, 재백업·새 DB 복원과 계정·세션·리포트 API 응답을 대조합니다. 원본 서비스와 백업은 보존하고 검증 전용 컨테이너·볼륨·임시 파일만 정리합니다. Docker가 실행 중이어야 하며 최초 이미지 빌드에는 인터넷 연결이 필요합니다. 별도 프로젝트를 사용 중이면 백업·시드·복원 명령에도 같은 `COMPOSE_PROJECT_NAME`과 환경 파일 설정을 전달합니다.

### 로컬 장애 복구

DB·Redis가 잠시 중지됐으면 `docker compose start postgres redis`로 같은 볼륨을 재기동하고 `/health`가 200으로 돌아오는지 확인합니다. API는 Redis에 계속 재연결하므로 별도의 API 재시작이 필요하지 않습니다. 장애 동안 Health와 해당 의존성이 필요한 API는 503을 반환합니다. 서버는 SIGINT·SIGTERM 시 진행 중 요청·Roll-up을 기다리고 DB·Redis 연결을 정리합니다. 기본 종료 제한은 8초이며 Docker 종료 유예 시간을 더 길게 둡니다.

Redis 블랙리스트 데이터가 사라졌거나 유실이 의심되면 **API를 먼저 중지**하고 복구합니다.

```bash
docker compose stop --timeout 15 backend
npm run local:recover-auth
curl --fail http://localhost:3000/health
```

복구 명령은 JWT 비밀값 교체와 모든 Refresh Token 폐기를 함께 수행하고 API를 다시 만듭니다. 모든 사용자는 다시 로그인해야 하며 계정·세션·리포트는 유지합니다. 실패 시 API 중지 상태를 유지하고 같은 명령으로 재시도합니다. 실행 중 Redis 초기화를 자동 감지하는 기능은 없으므로 Redis를 비우거나 교체하기 전에 API를 중지합니다. 기존 프로젝트 이름과 `LOCAL_ENV_FILE` 설정을 그대로 사용합니다.

`npm run verify:recovery`는 별도 임시 환경에서 실제 장애·복구와 토큰 무효화를 재검증합니다. 종료 로그, 실패 시 처리, 잠금 파일 처리 등은 [장애 복구 운영 절차](performance-operations.md#7-로컬-장애-복구와-종료)를 참조합니다.

---

## 💻 프런트엔드 (Frontend) 팀 전달 사항

현재 `frontend/`에 로그인·세션·대시보드·리포트·프로필 화면 소스가 있습니다. 소셜·그룹을 포함한 추가 화면의 브랜치 통합 및 브라우저 검증은 프런트엔드 통합 단계에서 진행합니다.

1. **API 서버 정보**
   - **Base URL:** `http://localhost:3000`
   - **Health Check API:** `GET /health` (DB·Redis 모두 연결 시 200, 하나라도 끊기면 503, 프로세스 운영 카운터는 `data.metrics`)
   - **CORS 설정:** Docker 로컬 실행은 `LOCAL_CORS_ORIGIN`(기본 `http://localhost:5173`)을 사용합니다. 호스트에서 백엔드를 직접 실행할 때는 `backend/.env`의 `CORS_ORIGIN`을 사용합니다.

2. **API 라우터 기본 구조**
   - 구현된 라우터: `/api/auth`(회원가입·로그인·갱신·로그아웃), `/api/sessions`(시작·v1 로그·종료·조회), `/api/v2/sessions`(측정 시각 기반 로그), `/api/reports`(세션별·주간·월간), `/api/users`(프로필·프라이버시), `/api/connections`(친구 요청·응답·조회), `/api/session-shares`(공유·피드·공감), `/api/rankings`, `/api/groups`(그룹·초대·멤버·목표·피드백).
   - 상세 요청·응답은 `docs/api-spec.md`, 실행 가능한 OpenAPI 문서는 `http://localhost:3000/api-docs/`에서 확인한다. `POST /api/auth/refresh`는 30일 회전형 Refresh Token을 발급한다.
   - 페이지 목록은 기본 20건, 최대 100건이며 모든 응답의 `X-Request-ID`로 서버 JSON 로그를 추적할 수 있다. 성능 기준과 Redis 장애 동작은 `docs/performance-operations.md`를 참조한다.

3. **인증 (Authentication)**
   - API 연동 시 JWT Access Token을 `Authorization: Bearer <token>` 헤더에 담아 전송해야 합니다.
   - Access Token 401에는 `POST /api/auth/refresh`를 한 번 호출한다. 회전된 Refresh Token을 저장하고 원 요청을 한 번만 재시도한다.
   - Refresh Token은 JSON body 또는 `focuslens_refresh_token` HttpOnly cookie로 전달할 수 있다.

---

## 🤖 AI 개발 팀 전달 사항

### 일반 로컬 서버에 연속 측정 연결

별도 백엔드 실행 도구가 기존 AI의 카메라·3초 보정·1분 집계를 재사용해 SQLite 영속 큐와 로그 v2를 연결합니다. 기존 `focuslens-ai` 명령은 계속 프레임 측정 도구로 사용할 수 있습니다. 아래는 macOS의 키체인을 사용하는 실행 절차입니다. Python 3.11과 카메라가 필요합니다.

```bash
npm run local:up
python3.11 -m venv .local/ai-venv
.local/ai-venv/bin/python -m pip install -e './ai[dev]'
export FOCUSLENS_AI_PYTHON="$PWD/.local/ai-venv/bin/python"
npm run local:ai -- login --email user_a@focuslens.dev
npm run local:ai -- measure --minutes 2
```

로그인은 비밀번호를 화면에 표시하지 않는 입력창으로 받습니다. 위 테스트 계정은 `local:seed`를 실행한 환경에만 있으며, 회원가입한 계정도 사용할 수 있습니다. JWT·Refresh Token은 서버 주소와 사용자 UUID에 따라 분리된 macOS 키체인 항목에 저장합니다. 비밀번호는 저장하지 않습니다. `FOCUSLENS_AI_PYTHON` 대신 기존 `AI3_PYTHON`·`AI2_PYTHON` 설정도 사용할 수 있습니다.

측정 시작 후 처음 3초는 정면을 바라보고, 이후에는 평소처럼 화면을 봅니다. `--minutes 2`는 보정 후 실제 60초 구간 두 개를 측정합니다. `--minutes`를 생략하거나 0으로 두면 Ctrl+C까지 계속 측정합니다. 한 분에 유효 표본 480개를 확보하지 못하면 그 구간을 건너뛰고, 미완성 마지막 구간은 보내지 않습니다. 카메라가 한 분 넘게 끊긴 구간을 가짜 표본으로 채우지 않습니다.

완료된 각 분은 HTTP 전송 전에 SQLite에 커밋합니다. 전송은 별도 스레드가 수행하므로 네트워크 재시도 중에도 다음 분을 계속 측정합니다. 기존 눈 감김·시선·자세·가중 점수식은 그대로 사용합니다. 모델은 처음 필요할 때 `.local/ai/models/face_landmarker.task`에 내려받으며 `FOCUSLENS_MODEL_PATH`로 기존 모델 경로를 지정할 수 있습니다. 영상과 프레임별 원문 특징은 파일로 저장하지 않습니다.

```bash
npm run local:ai -- status
# 프로세스가 예기치 않게 끝난 측정을 같은 세션에서 계속하려면
npm run local:ai -- resume --minutes 2
# 측정을 추가하지 않고 저장된 로그만 보내고 세션을 끝내려면
npm run local:ai -- finish
```

정상 측정 완료나 Ctrl+C 후에는 큐를 비우고 세션 종료·리포트 생성을 요청합니다. 전송 실패·재로그인 필요·거절된 로그가 남아 있으면 세션 종료를 보류합니다. 서버 복구 후 필요하면 다시 `login`하고 같은 상태 디렉터리에서 `finish`를 실행합니다. 이미 종료 대기 중인 `resume`은 새 카메라 측정 대신 전송·종료를 마무리합니다. 강제 종료로 저장하지 못한 미완성 분은 재시작 후 복원하지 않으며, 완료 로그의 ID·측정 시각은 재시도 시 유지합니다. 거절된 로그는 자동으로 버리지 않습니다.

기본 API는 `http://127.0.0.1:3000`, 상태·큐 경로는 `.local/ai/<서버주소해시>/`입니다. `.local/`은 Git과 이미지 빌드에서 제외합니다. 같은 디렉터리를 쓰는 동시 실행은 차단합니다. 계정을 바꿀 때는 별도 `--state-dir`를 사용하며, 다른 서버의 큐·토큰은 섞지 않습니다. 다른 포트를 쓰면 모든 명령에 같은 전역 옵션을 전달합니다.

```bash
npm run local:ai -- --base-url http://127.0.0.1:13000 --state-dir .local/ai-other login --email 사용자이메일
npm run local:ai -- --base-url http://127.0.0.1:13000 --state-dir .local/ai-other measure --minutes 2
```

시작 응답이 유실돼 `starting` 상태가 남으면 `resume`은 발견한 세션의 UUID·시작 시각을 출력하고 확인을 요구합니다. 해당 세션이 이 측정에서 시작한 세션인지 확인한 뒤 `resume --confirm-session UUID` 또는 `finish --confirm-session UUID`로 진행합니다. 이미 프런트에서 진행 중인 세션은 새 `measure`가 자동으로 가져오지 않습니다.

실제 전체 경로 재검증은 `npm run verify:local-ai`입니다. 실행 중인 일반 로컬 서버에 검증 계정·세션 하나를 생성하고, 별도 루프백 프록시에서만 로그 전송 중단·응답 유실을 재현합니다. 카메라로 2분을 실제 측정한 뒤 별도 프로세스에서 키체인 인증과 큐를 재사용해 전송·종료하고 DB·리포트를 대조합니다. 원래 DB·Redis 서비스는 중지하지 않습니다. 성공 시 검증용 키체인 항목만 삭제하고, 비밀값을 제외한 증거와 큐를 `.local/ai-verification/`에 보관합니다. 세션 시각을 소급하지 않습니다.

측정은 끝났지만 후속 검증이 중단된 경우 `npm run verify:local-ai -- --resume-evidence .local/ai-verification/기존디렉터리`로 저장된 카메라 결과·큐·키체인 인증을 재사용할 수 있습니다. 원래 루프백 프록시 포트가 비어 있어야 하며, 새 촬영·로그인·계정 생성은 하지 않습니다. 최초 기록은 `initial-evidence.json`에 보존하고 결과는 같은 디렉터리의 `evidence.json`으로 원자 교체합니다. 일반 사용자의 세션 복구는 위 `local:ai resume`·`finish`를 사용합니다.

### 현재 AI 실행 프로그램 (2026-10-06)

`ai/`에는 Python 3.11 기반 로컬 웹캠 측정 프로그램이 구현돼 있다. OpenCV와 MediaPipe Face Landmarker로 약 10 FPS의 프레임을 처리하며, 얼굴 검출, 홍채 상대 위치, blink blendshape·단일 프레임 눈 감김, yaw/pitch/roll을 출력한다. 디버그 화면과 프레임별 JSON 출력이 가능하다. 진행 상태와 백엔드 연동 선행 조건은 `docs/integration-readiness.md`, 실행 세부 사항은 `ai/README.md`를 참조한다.

```bash
cd ai
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
focuslens-ai --print-values
```

첫 실행 시 Face Landmarker 모델을 `ai/models/face_landmarker.task`로 내려받는다. 미리보기 창은 `q` 또는 `ESC`로 닫는다. `FOCUSLENS_MODEL_PATH`로 모델 경로를 바꿀 수 있다.

`focuslens-ai` 원래 명령은 프레임별 특징 측정을 수행하고 로그를 자동 전송하지 않는다. 사용자별 보정·blink 이벤트·1분 점수 집계와 웹캠→큐→v2 전송은 위 백엔드의 별도 `local:ai` 도구로 연결한다. 기존 AI의 `FOCUSLENS_API_BASE_URL`, `FOCUSLENS_ACCESS_TOKEN` 환경변수는 이 새 도구의 인증 저장 방식과 구분한다.

1. **AI 추론 결과 저장 테이블 (`concentration_logs`)**
   - 별도 `local:ai` 도구의 1분 점수 집계는 백엔드 API를 거쳐 `concentration_logs`에 저장된다. 기존 `focuslens-ai` 명령 자체는 자동 전송하지 않는다.
   - **제약 조건:** `focus_score`, `gaze_score`, `blink_score`, `head_score`는 모두 `0` 이상 `100` 이하의 Float 값이어야 합니다.
   - **상태 값:** `attention_state` 컬럼은 `FOCUSED`, `NORMAL`, `DISTRACTED` 세 가지 Enum 값만 허용됩니다.
   - 신규 연동은 `POST /api/v2/sessions/:id/log`에 JWT, `client_log_id`, `measured_at`, 네 점수와 `face_detected`를 보낸다. 백엔드는 원래 측정 시각으로 분 구간을 계산하고 client ID와 분 구간 UNIQUE 제약으로 멱등 저장한다. v1은 기존 클라이언트 호환을 위해 유지한다. `local:ai`는 영속 큐에 기록한 같은 요청을 재전송한다.

2. **파생 데이터(통계, 랭킹) 조회 원칙**
   - 평균 집중도, 총 학습 시간 등의 집계 데이터는 기본 테이블에 저장하지 않고 **미리 생성된 View를 통해 조회**합니다. AI 모델 결과 평가나 통계 추출 시 아래 View를 활용해 주세요.
     - `v_user_session_summaries`: 개별 세션의 평균 집중도 및 시간 요약
     - `v_session_metric_totals`: 원본과 시간·일·주 Roll-up의 세션별 통합 수치
     - `v_group_member_stats`: 그룹 멤버별 기간 내 누적 통계
     - `v_rankings`: 참여자 전체 랭킹 조회 (프라이버시 설정이 반영된 뷰)

3. **DB 접속 정보**
   - 로컬 DB 도구(DBeaver, DataGrip 등) 접속 주소:
     `postgresql://focuslens:focuslens_pw@localhost:5432/focuslens?schema=public`
