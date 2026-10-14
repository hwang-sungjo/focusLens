# FocusLens Frontend

React와 TypeScript로 만든 FocusLens 웹 화면입니다. 백엔드 API(`backend/`)에 연결해 로그인, 학습 세션, 대시보드, 리포트, 프로필 화면을 제공합니다.

> 작업 브랜치: `uiux`

## 화면과 사용하는 API

| 화면 | 경로 | 사용하는 API |
| --- | --- | --- |
| 로그인 | `/login` | `POST /api/auth/login` |
| 회원가입 | `/register` | `POST /api/auth/register` |
| 대시보드 | `/dashboard` | `GET /api/reports/weekly`, `GET /api/reports/monthly` |
| 학습 세션 | `/session` | `POST /api/sessions/start`, `/:id/log`, `/:id/end`, `GET /api/sessions?status=IN_PROGRESS` |
| 리포트 | `/reports` | `GET /api/sessions?status=COMPLETED`, `GET /api/reports/:session_id` |
| 프로필 / 설정 | `/profile` | `GET /api/users/:id/profile`, `PATCH /api/users/me/profile`, `GET·PATCH /api/users/me/privacy` |

- 로그아웃은 위쪽 메뉴의 👤 버튼에서 `POST /api/auth/logout`을 호출합니다.
- `/`는 대시보드로, 없는 주소는 `/`로 이동합니다. 로그인하지 않은 상태면 로그인 화면으로 이동합니다.
- 화면별 API 기준은 `docs/frontend-api-map.md`를 따릅니다.

## 화면별 기능 (기획서 6.3절 기준)

**대시보드**
- 오늘 집중도 원형 게이지, 오늘 학습 시간
- 주간·월간 전환 토글: 평균 집중도, 기간 학습 시간, 날짜별 집중도 추이 차트
- 오른쪽 아래 고정 "새 학습 시작" 버튼
- 날짜는 서버 규칙대로 UTC 기준입니다(`docs/api-spec.md` 1.5절). 한국 시간 오전 0~9시에 시작한 세션은 전날로 집계되며, 차트 아래에 안내 문구가 있습니다.

**학습 세션**
- 넓은 화면에서는 왼쪽 2/3에 웹캠, 오른쪽 1/3에 타이머·점수·Gaze/Blink/Head 막대가 나옵니다. 좁은 화면에서는 세로로 배치됩니다.
- **이탈 알림음:** 1분마다 받는 판정이 "집중 이탈"이면 소리가 납니다. "🔔 이탈 알림음" 버튼으로 켜고 끄며(켤 때 미리듣기로 한 번 울림), 기본값은 꺼짐이고, 설정은 브라우저(`localStorage`)에 기억됩니다. 소리 파일 없이 Web Audio로 짧은 소리(0.15초)를 냅니다.
- **리프레시 안내 팝업:** "집중 이탈"이 2분 연속이면 스트레칭·물 마시기 같은 안내 팝업을 띄웁니다. 한 번 띄우면 10분 동안은 다시 띄우지 않습니다.
- 알림 횟수, 대기 시간, 안내 문구는 `SessionPage.tsx` 위쪽 설정 블록에서 바꿀 수 있습니다.

**리포트**
- 세션 요약(날짜, 학습 시간, 평균 집중도)
- 분 단위 집중도 면적 그래프와 Gaze/Blink/Head 꺾은선
- 집중 TOP3 / 이탈 TOP3 구간 카드: 같은 상태가 이어진 구간을 길이순으로 정렬하고, 길이가 같으면 평균 점수로 정렬합니다.
- **30일이 지난 세션:** 서버가 분 단위 기록을 시간·일·주 단위로 합쳐서 보냅니다(Roll-up, `docs/rollup-strategy.md`). 이 경우 "단위 평균으로 표시된다"는 안내를 띄우고 TOP3 카드는 숨깁니다. 구간을 분 단위로 나눌 수 없기 때문입니다.

## 아직 더미인 부분

| 위치 | 현재 | 바뀔 내용 |
| --- | --- | --- |
| `SessionPage.tsx`의 `sendDummyLog` | gaze·blink·head 점수를 `Math.random()`으로 만들고 `face_detected: true`를 고정 전송 | AI 측정값으로 교체. 점수를 누가 계산·전송할지(브라우저 또는 `ai/` Python 프로그램)는 팀 결정 대기 |
| 같은 함수의 total 계산 | `gaze × 0.4 + blink × 0.3 + head × 0.3` (백엔드 `focusScore.js`와 동일) | 가중치 최종값이 정해지면 맞춤 |
| 세션 화면 웹캠 | 화면에 보여주기만 하고 분석에는 쓰지 않음 | AI 연동 방식이 정해지면 연결 |

로그는 v1 API(`POST /api/sessions/:id/log`)로 1분마다 보냅니다. v2로 바꿀지도 AI 연동 방식에 따라 정합니다.

## 기획서와 다르게 한 부분

| 기획서 | 현재 | 이유 |
| --- | --- | --- |
| 대시보드 최근 세션 카드 목록 | 없음 | 리포트 화면의 세션 목록과 겹침 |
| 리포트 "다음 학습 시작" / "대시보드로" 버튼 | 없음 | 위쪽 메뉴와 대시보드 고정 버튼으로 대신함 |
| 이탈 시 소리 **또는 진동** | 소리만 | 진동은 iPhone(Safari)에서 지원하지 않아 제외 |
| 눈 감지 시 팝업 가이드 | 이탈 연속 시 팝업만 | 눈 감음 신호는 AI 연동 후 추가 |
| 글꼴 Noto Sans KR / Inter | 기기 기본 글꼴 | 별도 글꼴을 받지 않고 시스템 글꼴 사용 |
| 버튼·입력칸 모서리 12px | 8px (카드는 12px) | 디자인 판단으로 유지 |
| 회원가입 후 바로 사용 | 로그인 화면으로 이동 | 아래 "설계상 결정" 참고 |

## 미구현

- **백엔드 API가 없어 대기:** 세션 일시정지, 비밀번호 찾기, 알림 설정
- **AI 쪽 작업 대기:** 실제 집중도 점수, 눈 감지 팝업, 카메라 보정
- **기획서 "고도화" 항목:** 리포트 PDF 내보내기
- **범위 합의 대기:** 친구, 소셜 피드, 랭킹, 그룹 화면. API는 백엔드에 구현돼 있습니다(`docs/frontend-api-map.md` 1절).

## 검증하지 못한 부분

- **실제 카메라:** 지금까지 카메라가 없는 데스크탑에서만 확인했습니다.
- **Roll-up 안내:** 로컬은 `ROLLUP_ENABLED=false`이고 시드 데이터에 30일 지난 세션이 없어서, 합쳐진 데이터로 안내가 뜨는 장면은 확인하지 못했습니다. 코드는 `docs/frontend-api-map.md` 2절의 `granularity` 규칙을 따릅니다.
- **팀 E2E 시나리오**(`docs/product-e2e-scenarios.md`)와 반응형·접근성 점검(`docs/integration-readiness.md` 5절)은 아직 진행하지 않았습니다.

## 기술 스택

React 19, TypeScript, Vite, Tailwind CSS v4(`@tailwindcss/vite`), React Router v7, Chart.js(`react-chartjs-2`)

## 실행 방법

### 1. 백엔드 먼저 실행

`docs/setting-guide.md`를 따라 프로젝트 루트에서 백엔드를 실행합니다.

```bash
docker compose up -d --build
npm run db:migrate:deploy   # 저장소에 있는 migration만 적용
npm run db:views
npm run db:seed
```

> ⚠️ `npm run db:migrate`(Prisma `migrate dev`)를 실행하면 `schema.prisma`와 migration 파일의 인덱스 이름 차이 때문에 새 migration 파일이 자동 생성될 수 있습니다. 이름을 물어보면 Ctrl+C로 중단하세요. 이미 생성됐다면 커밋하지 말고 삭제한 뒤 `npm run db:reset`으로 저장소 기준 상태로 되돌립니다.

`http://localhost:3000/health`가 200이면 준비된 것입니다.

### 2. 프론트엔드 실행

```bash
cd frontend
cp .env.example .env.development   # 선택: 없으면 http://localhost:3000을 기본값으로 사용
npm install
npm run dev                        # http://localhost:5173
```

백엔드 CORS 설정은 `http://localhost:5173`을 허용합니다. 다른 포트를 쓰면 `backend/.env`의 `CORS_ORIGIN`도 바꿔야 합니다.

### 3. 테스트 계정 (시드 데이터)

| 이메일 | 비밀번호 | 비고 |
| --- | --- | --- |
| `user_a@focuslens.dev` | `password_a123!` | 일반 유저 |
| `user_b@focuslens.dev` | `password_b123!` | 일반 유저, A와 친구 관계 |
| `admin@focuslens.dev` | `password_admin123!` | 관리자, 스터디 그룹 OWNER |

### 4. 알림·팝업 테스트 (개발용)

더미 점수는 무작위라 이탈 상태가 연속으로 잘 나오지 않습니다. `http://localhost:5173/session?forceDistracted`로 접속하면 점수를 30점 이하로만 보내서, 2분 뒤 알림음과 안내 팝업을 확인할 수 있습니다. `npm run dev`에서만 동작하고 배포 빌드에서는 무시됩니다.

## 명령어

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 실행 (타입 검사 없음) |
| `npm run build` | TypeScript 검사 후 배포용 빌드. **커밋 전에 실행** |
| `npm run lint` | ESLint 검사. 문제가 없으면 아무것도 출력하지 않음 |
| `npm run preview` | 빌드 결과물 미리보기 |

## 환경변수

| 이름 | 설명 | 기본값 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 백엔드 API 주소 | `http://localhost:3000` |

- `npm run dev`는 `.env.development`, `npm run build`는 `.env.production`을 읽습니다. `.env` 파일을 바꾸면 개발 서버를 다시 시작해야 합니다.
- 실제 `.env.*` 파일은 루트 `.gitignore`에 따라 커밋하지 않고, `.env.example`만 커밋합니다.
- 배포 주소가 정해지면 `.env.production`에 넣습니다. 이때 백엔드 `CORS_ORIGIN`에도 같은 주소를 정확히 넣어야 합니다. 쿠키를 주고받기 때문에 와일드카드(`*`)는 쓸 수 없습니다.

## 구조

```text
frontend/
├── .env.example           # 환경변수 목록
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx            # 라우팅, 네비게이션 바, 로그아웃
    ├── ProtectedRoute.tsx # 토큰이 없으면 /login으로 이동
    ├── api.ts             # 모든 API 요청이 거치는 공통 함수
    ├── index.css          # Tailwind와 디자인 토큰(@theme)
    └── pages/             # 화면 6개
```

## 설계상 결정 사항

**공통 API 클라이언트 (`src/api.ts`)**
- 모든 요청은 `apiFetch(path, options)`를 씁니다. 주소, `Authorization` 헤더, 쿠키 전송(`credentials: 'include'`)을 자동으로 처리합니다.
- **401:** Refresh Token(HttpOnly 쿠키)으로 한 번 갱신한 뒤 원래 요청을 한 번 다시 보냅니다. 갱신에 실패하면 `/login?expired=true`로 이동합니다(`docs/auth-flow.md` 7절). 여러 요청이 동시에 401을 받아도 갱신은 한 번만 합니다. 같은 Refresh Token을 두 번 쓰면 서버가 재사용으로 판단해 로그인 전체를 폐기하기 때문입니다.
- 로그인·회원가입·로그아웃은 `skipAuthRefresh: true`로 갱신을 건너뜁니다. 여기서 받는 401은 만료가 아니라 인증 실패이기 때문입니다.
- **오류 문구:** `getErrorMessage()`가 상태 코드별 문구를 만듭니다. 400·409는 서버 문구를 그대로 쓰고, 403은 권한 안내를, 500·503은 `X-Request-ID`를 함께 보여줍니다(`docs/frontend-api-map.md` 2·3절). 데이터를 불러오는 화면에는 [다시 시도] 버튼이 있습니다.

**화면 동작**
- 회원가입 후에는 **자동 로그인하지 않고** 로그인 화면으로 이동합니다. 서버 응답에 토큰이 들어 있지만 일부러 쓰지 않습니다(`docs/frontend-api-map.md` 회원가입 항목과 다름).
- 세션 화면에 들어오거나, 시작할 때 409를 받으면 서버에 남아 있는 진행 중 세션을 **이어하기 / 종료하기** 중에서 고를 수 있습니다. 이어하기는 서버 `started_at` 기준으로 타이머를 맞춥니다. 일시정지가 없어서 자리를 비운 시간도 학습 시간에 포함됩니다.
- 평균 점수 등이 `null`이면 0이 아니라 "기록 없음"으로 표시합니다(`docs/frontend-api-map.md` 2절). 차트에서도 기록 없는 날은 0으로 그리지 않고 건너뜁니다.
- Chart.js 차트는 부모에 고정 높이(`h-64`)를 주고 `maintainAspectRatio: false`를 씁니다. 이렇게 하지 않으면 좁은 화면에서 가로로 넘칩니다.
