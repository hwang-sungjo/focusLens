# FocusLens 로컬 프런트 인계

> 기준일: 2026-11-26 · FE-4 로컬 제품 통합 검증
> API 상세: [API 명세](api-spec.md), [화면별 매핑](frontend-api-map.md)
> 전체 진행: [백엔드 계획](backend-plan.md), AI 실행: [로컬 실행 가이드](setting-guide.md)

FE-1에서 로컬 백엔드·AI 측정 도구와 프런트 11개 화면을 `main`에 모았고, FE-2에서 Chromium으로 기존 화면과 실제 API의 연동을 확인했다. FE-3에서 기존 세션 버튼을 로컬 AI에 연결했다. FE-4에서 카메라 실측 2분과 전송 복구를 거쳐 리포트 평균 98.38점이 표시 정밀도에 맞게 반영되는 것을 확인했다.

## 1. 실행 주소와 명령

Node.js 22.x(22.13 이상)를 설치하고 Docker Desktop을 실행한다. Mac에서 카메라 측정까지 사용하려면 Python 3.11도 준비한다. VS Code로 `focusLens` 폴더를 열고 **터미널 → 새 터미널**에서 실행한다.

```bash
npm start
```

첫 실행은 프런트 패키지를 설치하고, Mac에서는 AI용 Python 가상환경과 패키지도 준비한다. 백엔드는 PostgreSQL·Redis를 준비하고 저장소의 migration과 조회 View를 적용한다. 이미 실행 중인 FocusLens 서비스는 재사용한다. Windows에서 같은 명령을 쓰면 프런트와 백엔드가 실행되고, 터미널에 카메라 측정 제한이 표시된다.

준비가 끝나면 [로그인 화면](http://localhost:5173/login)을 연다. 새 환경에서는 회원가입하거나, 기본 테스트 계정이 필요하면 별도 터미널에서 `npm run local:seed`를 한 번 실행한다. 계정 목록은 아래 2절에 있다.

| 대상 | 로컬 값 |
| --- | --- |
| 프런트 | `http://localhost:5173` |
| API | `http://localhost:3000` |
| 로컬 AI | `http://127.0.0.1:4317` (`VITE_LOCAL_AI_ORIGIN`) |
| Swagger | `http://localhost:3000/api-docs/` |
| Health | `http://localhost:3000/health` — DB·Redis 정상 시 200 |
| 프런트 API 설정 | `frontend/.env.development`의 `VITE_API_BASE_URL=http://localhost:3000`; 없으면 같은 기본값 |
| Compose CORS 설정 | `LOCAL_CORS_ORIGIN=http://localhost:5173` |
| 호스트에서 직접 API 실행 시 CORS | `backend/.env`의 `CORS_ORIGIN=http://localhost:5173` |

프런트와 API의 호스트 이름은 모두 `localhost`로 맞춘다. `localhost`와 `127.0.0.1`을 섞으면 SameSite 쿠키 전달과 CORS가 달라질 수 있다. 별도 포트를 쓸 때는 `LOCAL_API_PORT`, `VITE_API_BASE_URL`, `LOCAL_CORS_ORIGIN`을 함께 맞추고 API 컨테이너와 Vite를 다시 시작한다. Compose에서는 `backend/.env`의 CORS 값보다 `LOCAL_CORS_ORIGIN` 설정이 우선한다.

측정 중이면 먼저 화면에서 **세션 종료**를 누른다. `npm start`를 실행한 터미널에서 `Ctrl+C`를 누르면 이번에 시작한 서비스가 종료된다. 계정과 학습 기록은 DB 볼륨에 보존된다. 별도로 기동한 백엔드는 `npm run local:down`으로 종료할 수 있다.

## 2. 테스트 계정과 계정 분리

| 이메일 | 최초 시드 비밀번호 | 용도 |
| --- | --- | --- |
| `user_a@focuslens.dev` | `password_a123!` | 일반 사용자 A |
| `user_b@focuslens.dev` | `password_b123!` | 일반 사용자 B, 시드에서 A와 친구 |
| `admin@focuslens.dev` | `password_admin123!` | 전역 ADMIN, 시드 스터디 그룹의 OWNER |

기존 계정의 비밀번호·관계·역할을 바꾼 환경에서는 변경한 값을 사용한다. 시드는 과거 상태를 강제로 되돌리지 않는다. 전역 `users.role=ADMIN`이 모든 그룹의 관리 권한을 뜻하지 않는다. 각 그룹 권한은 활성 `group_members.group_role`로 판단한다.

다중 계정은 별도 브라우저 프로필·시크릿 컨텍스트로 나눠 로그인한다. 같은 브라우저 컨텍스트의 탭은 `localStorage`와 Refresh 쿠키를 공유한다. 같은 컨텍스트에서 계정을 번갈아 바꾸며 동시에 사용하는 동작은 이번 인계의 보장 범위가 아니다.

## 3. 인증과 오류 계약

프런트 `src/api.ts`는 Access Token을 `localStorage`에 저장하고 `Authorization: Bearer`로 보낸다. Express 요청에는 `credentials: 'include'`를 사용한다. 로컬 AI에는 Bearer만 보내며 쿠키 갱신은 Express가 처리한다. 로컬 Refresh 쿠키는 `HttpOnly`, `SameSite=Lax`, host-only, `Path=/api/auth`이며 HTTP 로컬 환경에서는 Secure를 요구하지 않는다. Refresh Token을 프런트 저장소에 복사하지 않는다.

보호 요청이 401이면 쿠키로 Refresh를 한 번 시도한다. 동시에 갱신이 필요한 요청은 같은 Promise를 공유하고, 새 Access Token을 받으면 각 원래 요청을 한 번 재시도한다. 로그인·가입·로그아웃 요청은 자동 갱신을 건너뛴다. 회원가입 성공 후에는 로그인 화면으로 이동한다.

Refresh가 429를 제외한 4xx를 반환하면 저장한 인증 정보를 지우고 `/login?expired=true`로 이동한다. Refresh의 429·5xx나 네트워크 오류에서는 인증 정보를 유지하고 호출한 화면에 오류를 전달한다. 로그아웃은 body의 Refresh Token을 우선하고 없으면 쿠키를 사용해 해당 토큰 계열을 폐기한다. 둘 다 없으면 해당 사용자의 모든 활성 Refresh Token을 폐기한다.

| 상태 | 처리 기준 |
| --- | --- |
| 400 | 입력값·점수·요청 조건 오류를 수정한다. |
| 401 | 보호 요청에서 쿠키 갱신을 시도한다. 성공하면 원래 요청을 재시도하고, Refresh Token이 무효하면 재로그인한다. |
| 403 | 인증은 유지하고 권한 부족을 안내한다. |
| 404 | 없거나 조회할 수 없는 리소스임을 안내한다. |
| 409 | 이미 진행 중인 세션·분 구간 충돌·중복 상태를 확인한다. |
| 500 | 일반 오류와 `X-Request-ID`를 보여준다. |
| 503 | 일시 장애를 안내하고 응답에 있으면 요청 ID를 표시한다. Refresh 중 503에서도 로그인 상태를 유지한다. |

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

프로필 화면에서 기본 세션 공개 범위, 점수 공개 범위, 학습 시간 공개 범위(`study_time_visibility`)를 각각 편집할 수 있다. GET과 PATCH 모두 `PUBLIC`, `FRIENDS`, `GROUP`, `PRIVATE`를 사용한다. 그룹 데이터 공유(`group_data_sharing`)와 랭킹 참여(`ranking_participation`)는 각각 켜고 끌 수 있다.

`avg_focus_score`, `duration_seconds` 등의 `null`은 0으로 변환하지 않는다. 무기록과 비공개를 다른 API를 조합해 복원하지 않는다. 그룹 관리 버튼의 표시 여부와 관계없이 서버의 403을 최종 판단으로 삼는다. 그룹 생성자 ID 또는 전역 ADMIN만으로 권한을 추론하지 않는다.

## 5. 세션 화면에서 카메라 측정하기

`npm start`로 AI를 함께 실행했다면 아래의 **학습 세션 → 세션 시작** 단계로 이동한다. AI만 별도로 실행할 때는 저장소 루트에서 다음 명령으로 Python 3.11 가상환경과 AI 패키지를 준비한다.

```bash
python3.11 -m venv .local/ai-venv
.local/ai-venv/bin/python -m pip install -e ./ai
```

시연용 Mac에는 Python 3.11.18이 `.local/python-3.11/bin/python3.11`에 설치되어 있다. 이 컴퓨터에서 가상환경을 다시 만들 때는 위 첫 명령의 `python3.11` 자리에 이 경로를 쓴다.

백엔드와 Vite가 실행 중이면 새 터미널을 열고 저장소 루트에서 AI를 기동한다. 실행기는 기본으로 `.local/ai-venv/bin/python`을 선택한다. 다른 Python 환경을 사용하려면 `FOCUSLENS_AI_PYTHON`에 해당 실행 파일의 절대 경로를 지정한다.

```bash
npm run local:ai:web
```

기본 모델 경로는 `.local/ai/models/face_landmarker.task`다. 파일이 있으면 다음 측정에도 재사용하고, 없으면 첫 측정 시 내려받는다. 다른 위치의 모델을 사용하려면 실행 전에 `FOCUSLENS_MODEL_PATH`에 파일의 절대 경로를 지정한다. macOS에서 카메라 권한을 요청하면 Python을 실행한 앱에 허용한다. 주소를 바꾼 환경은 `--base-url`에 로컬 API 주소, `--frontend-origin`에 실제 프런트 주소를 넘긴다. AI 포트를 바꾸면 `--port`와 `VITE_LOCAL_AI_ORIGIN`을 함께 변경한다.

1. 브라우저에서 로그인하고 **학습 세션 → 세션 시작**을 누른다. Python이 컴퓨터의 카메라를 열면 처음 3초 동안 화면 중앙을 바라본다. 웹캠 숨기기는 화면의 미리보기만 끈다.
2. 보정 후 유효한 1분 측정이 끝나면 점수·판정과 Gaze/Blink/Head가 표시된다. Python이 각 분을 SQLite에 저장한 뒤 v2로 전송한다. 소리와 연속 이탈 안내는 새 분의 판정을 받을 때 동작한다.
3. **세션 종료**를 누르면 미전송 기록까지 전송한 뒤 세션을 닫는다. 연결 문제로 종료가 보류되면 같은 계정과 서버로 돌아와 **종료하기**를 다시 누른다. 리포트에서 완료된 세션을 확인한다.

마지막으로 인증된 세션 화면의 상태 요청이 끊기고 약 90초가 지나면 카메라 측정을 멈추고 큐와 세션을 보존한다. 화면을 다시 열었을 때 측정이 계속 진행 중이면 자동으로 표시된다. 중단됐으면 **이어하기** 또는 **종료하기**를 선택한다. 시작 응답만 유실된 경우에는 서버의 진행 세션 시각을 확인한 뒤 선택한다. CLI나 이전 클라이언트에서 시작한 세션이면 원래 도구에서 마무리한다. CLI는 해당 서버·계정·상태 디렉터리의 `local:ai -- finish`로 큐를 먼저 전송한다.

## 6. 재검증

### FE-4 여러 분 측정과 전송 복구

저장소 루트에서 `npm run verify:fe4`를 실행하면 별도 Docker 프로젝트와 Chromium으로 2분 동안 테스트 입력을 측정한다. 실제 카메라를 사용하려면 같은 Python 환경에서 `npm run verify:fe4 -- --live`를 실행하고, 카메라가 열릴 때 처음 3초간 화면 중앙을 본 뒤 2분 동안 평소처럼 화면을 본다.

검증기는 테스트용 AI 실행기의 로그 전송을 끊는다. 브라우저에서 대기 2건과 종료 보류를 확인한 뒤 연결을 복구하고, 서버가 첫 기록을 저장한 직후 응답을 한 번 유실시킨다. 종료 후 두 분의 ID·측정 시각·점수를 SQLite 및 PostgreSQL과 대조하고 리포트 평균을 확인한다. 이어서 과거 리포트와 친구 피드의 두 번째 페이지, 시간·일·주 단위 리포트 표시, 두 화면 폭에서의 키보드 조작과 저장 문자열 표시를 검사한다. 임시 계정과 DB는 실행이 끝날 때 정리된다.

### FE-3 카메라·세션 화면 검증

Docker, 프런트 및 루트 npm 의존성, Chromium과 위의 Python 환경을 준비한다. `npm run verify:fe3`는 테스트 특징 입력으로 카메라 중단·이어하기와 점수 전달을 반복 검증한다. `npm run verify:fe3 -- --live`는 물리 카메라를 열어 실제 1분을 측정하므로 정면에서 보정할 준비가 됐을 때 실행한다. 두 명령은 격리된 API·DB와 임시 계정을 쓴다. 2026-11-26 실측에서는 99.11점과 종료 리포트가 일치했다. [검증 기록](backend-plan.md)

### FE-2 실제 브라우저 검증

저장소 루트에서 다음 명령을 실행한다. Docker가 실행 중이어야 한다.

```bash
npm ci
npm ci --prefix frontend
npx playwright-core install chromium
npm run verify:fe2
```

검증 명령이 전용 Docker Compose 프로젝트에 PostgreSQL·Redis·API를 기동하고, 임시 디렉터리에 빌드한 프런트 프로덕션 번들을 제공한다. 프런트와 API는 모두 `127.0.0.1`의 서로 다른 임시 포트를 사용한다. 독립된 브라우저 컨텍스트에서 테스트 계정을 만들고, 종료 시 브라우저·프런트 서버·검증용 Docker 자원과 임시 파일을 정리한다.

| Chromium 151.0.7922.34에서 통과한 범위 | 화면과 API에서 확인한 결과 |
| --- | --- |
| 회원가입·로그인·대시보드·세션·프로필 | 가입 후 로그인, 주간·월간 대시보드, 진행 중 세션이 없는 대기 화면, 프로필 수정 후 새로고침까지 확인했다. 잘못된 Access Token으로 실제 401을 받아 HttpOnly 쿠키 회전과 원 요청 재시도를 확인했다. 한 계정의 로그아웃 뒤 다른 계정은 정상 갱신했고, 쿠키가 없으면 재로그인 안내가 표시됐다. 별도로 주입한 Refresh 503에서는 로그인 상태를 유지하고 수동 재시도에 성공했다. |
| 리포트·피드·친구·랭킹 | 테스트 세션을 시작해 실제 60초 경과 후 LBE-4 첫 분의 카메라 집계값 99.23점과 얼굴 미검출 테스트값 0점을 각각 v2로 전송했다. 대시보드와 리포트에서 각 점수를 확인했다. 공개 공유의 점수와 시간을 각각 가릴 때 API의 `null`과 피드의 ‘비공개’가 일치했고, 공유 범위를 비공개로 줄이자 다른 계정의 피드에서 사라졌다. 친구 요청·수락과 랭킹 점수도 확인했다. |
| 그룹 목록·상세 | 비공개 그룹 생성·초대·가입, OWNER·MANAGER·MEMBER의 조회 범위와 버튼을 확인했다. MANAGER가 보낸 피드백과 만든 목표가 MEMBER에게 읽기 전용으로 표시됐다. 비구성원 목록에 그룹이 숨겨졌으며 상세 주소로 접근하면 실제 403과 권한 안내가 표시됐다. |

이번 검증의 점수는 기존 실측 집계값과 고정 입력의 재생 결과다. FE-3 세션 제어 검증은 격리된 브라우저에서 `npm run verify:fe3`로 실행한다. FE-4에서는 실제 측정 중의 연결 복구까지 확인한다.

### 백엔드 인계 및 빌드 검증

```bash
npm run verify:handoff
npm run verify:local
npm run verify:openapi
npm --prefix frontend run build
npm --prefix frontend run lint
```

`verify:handoff`는 다중 계정·그룹 역할·공개 범위와 로컬 인증 인계 계약을 확인한다. 기존 AI 검증은 `verify:ai1`, `verify:ai2:focus:fixture`, `verify:ai3`를 사용한다. `verify:local-ai`는 카메라 준비 후 실행하는 실제 2분 측정이며 검증 계정·세션을 만든다. 실행 환경과 상세 절차는 [로컬 실행 가이드](setting-guide.md)를 따른다.

| LBE-5 당시 검증 (`develop@9e462a8`) | 결과 |
| --- | --- |
| CORS·쿠키·다중 계정·그룹·프라이버시 실제 API 검증 | 격리 PostgreSQL·Redis·API에서 109개 요청 통과, migration 11개·View 5개·시드 확인, 검증 자원 정리 완료 |
| 프런트 잠금 의존성 설치 후 build·lint | `npm ci --prefix frontend` 후 두 명령 모두 통과; manifest·lock·프런트 기능 소스 변경 없음 |
| 실제 브라우저 | Chrome 시크릿에서 localhost:5173 로그인→dashboard 이동 확인. 전용 브라우저 연결 호스트를 사용할 수 없고 네이티브 제어 대상이 바뀌어 쿠키 재발급·화면 종합 검증은 완료하지 못함 |

LBE-5 당시 HTTP 검증은 세 일반 계정과 전역 ADMIN을 분리해 쿠키·Refresh·로그아웃, 소유권 403, 친구·공유·반응·공개 범위 축소, 실제 경과 시간 마스킹, 그룹 동의·역할 이양·생성자 권한 감소·ADMIN 우회 차단을 확인했다. 당시 점수 마스킹의 검증 대상은 빈 세션의 `null`이었다. 비영점 점수의 마스킹과 Chromium의 쿠키 동작은 이후 FE-2에서 확인했다.

LBE-5 당시 npm 감사는 프런트 13건과 백엔드 운영 의존성 3건을 보고했다. 2026-11-27 시연-2에서 잠금 파일을 갱신한 뒤 두 범위 모두 0건을 확인했다. 백엔드 개발 도구에 남은 경고의 사용 범위와 실제 시연 환경의 확인 결과는 [시연-2 검증 기록](backend-plan.md#시연-2-검증-기록)을 따른다.

단위별 완료 기록과 다음 작업은 [백엔드 계획](backend-plan.md)을 따른다.
