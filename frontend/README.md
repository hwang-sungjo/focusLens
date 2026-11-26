# FocusLens Frontend

React와 TypeScript로 만든 FocusLens 웹 화면입니다. 백엔드 API(`backend/`)에 연결해 로그인, 학습 세션, 대시보드, 리포트, 프로필, 소셜(피드·랭킹·친구), 그룹 화면을 제공합니다.

> 로컬 백엔드와 AI를 연결한 상태에서 11개 화면을 검증했습니다. FE-4에서는 실제 카메라의 두 분 기록이 전송 단절·복구를 거쳐 리포트 평균 98.38점에 반영되는 것을 확인했습니다. [로컬 실행·인계 절차](../docs/frontend-handoff.md)

## 화면과 사용하는 API

| 화면 | 경로 | 사용하는 API |
| --- | --- | --- |
| 로그인 | `/login` | `POST /api/auth/login` |
| 회원가입 | `/register` | `POST /api/auth/register` |
| 대시보드 | `/dashboard` | `GET /api/reports/weekly`, `GET /api/reports/monthly` |
| 학습 세션 | `/session` | 로컬 AI의 `/start`·`/resume`·`/finish`·`/status`·`/preview`, 백엔드의 `GET /api/sessions?status=IN_PROGRESS` |
| 리포트 | `/reports` | `GET /api/sessions?status=COMPLETED`, `GET /api/reports/:session_id`, `POST /api/session-shares` |
| 피드 | `/feed` | `GET /api/session-shares/feed`, `POST·DELETE /api/session-shares/:id/reactions` |
| 랭킹 | `/rankings` | `GET /api/rankings` |
| 친구 | `/friends` | `GET /api/connections`, `POST /api/connections/request`, `PATCH /api/connections/:id` |
| 그룹 목록 | `/groups` | `GET·POST /api/groups`, `POST /api/groups/join` |
| 그룹 상세 | `/groups/:id` | `GET /api/groups/:id`, `/dashboard`, `/invite`, `PATCH·DELETE /members/:memberId`, `GET·POST /goals`, `POST /goals/:goalId/assignees`, `GET·POST /feedbacks` |
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
- 완료 세션 목록은 20개씩 불러오고, 더 있으면 아래 [더 보기] 버튼으로 다음 20개를 이어 붙입니다(`page`·`limit`, 서버가 알려 주는 전체 개수 기준).
- 세션 요약(날짜, 학습 시간, 평균 집중도)
- 분 단위 집중도 면적 그래프와 Gaze/Blink/Head 꺾은선
- 집중 TOP3 / 이탈 TOP3 구간 카드: 같은 상태가 이어진 구간을 길이순으로 정렬하고, 길이가 같으면 평균 점수로 정렬합니다.
- **[PDF로 저장]:** 브라우저 인쇄 창을 열고, 인쇄용 스타일(`print:` 클래스, `index.css`의 `@media print`)로 메뉴·세션 목록·버튼을 숨겨 A4 한 장에 리포트만 담습니다. 인쇄 창에서 "PDF로 저장"을 고르면 파일이 됩니다.
- **[공유하기]:** 전체 공개·친구·그룹 중 범위를 고르고 한마디(500자)를 붙여 공유합니다. 서버 규칙상 프로필의 "기본 세션 공개 범위"보다 넓게는 공유할 수 없어서, 허용되지 않는 범위는 미리 막아 둡니다. 새 계정의 기본값은 비공개라 프로필에서 범위를 넓혀야 공유할 수 있습니다.
- **30일이 지난 세션:** 서버가 분 단위 기록을 시간·일·주 단위로 합쳐서 보냅니다(Roll-up, `docs/rollup-strategy.md`). 이 경우 "단위 평균으로 표시된다"는 안내를 띄우고 TOP3 카드는 숨깁니다. 구간을 분 단위로 나눌 수 없기 때문입니다.

**피드**
- 전체(전체 공개 + 친구 + 내 그룹 + 내 글) / 친구 / 공개 탭, 20개씩 [더 보기]
- 학습 시간·점수는 올린 사람의 공개 설정에 따라 서버가 가려서 보내며, 이때 "비공개"로 표시합니다.
- 반응 3종(👍 좋아요, 🔥 응원해요, 🤝 공감해요)은 눌러서 추가, 다시 눌러서 취소합니다.

**랭킹**
- 누구끼리(전체·친구·그룹) × 기간(오늘·최근 7일) × 기준(집중도·학습 시간)을 고릅니다. 상위 50명과 내 순위를 보여 줍니다.
- 서버가 UTC 날짜로 집계해서 "오늘"은 한국 시간 오전 9시에 새로 시작합니다. "최근 7일"은 오늘 포함 지난 7일입니다.
- 프로필에서 "랭킹 참여"를 끈 사용자는 순위에 나오지 않습니다(새 계정 기본값은 꺼짐).

**친구**
- 받은 요청(수락·거절), 보낸 요청(취소), 친구 목록
- 친구는 **가입할 때 주어지는 고유 ID**(`users.id`)로 추가합니다. "내 ID"를 복사해 상대에게 보내고, 상대의 ID를 붙여넣어 요청합니다. 피드·랭킹의 다른 사람 옆 [+ 친구] 버튼으로도 바로 요청할 수 있습니다. 닉네임 검색은 두지 않기로 했습니다.

**그룹**
- 그룹 목록·만들기(만든 사람이 방장), 초대 코드로 가입
- 그룹 상세는 [멤버] [목표] [피드백] 탭으로 나뉩니다. 버튼은 서버 권한 규칙대로 역할별로 다르게 보입니다.

| 기능 | 방장 | 매니저 | 멤버 |
| --- | --- | --- | --- |
| 멤버 현황 | 전체 | 전체 | 나만 |
| 초대 코드 만들기 (친구 중에서·이메일) | ✅ | ✅ | |
| 역할 변경, 방장 넘기기 | ✅ | | |
| 내보내기 | 방장 외 모두 | 일반 멤버만 | |
| 목표 만들기·담당 지정 | ✅ | ✅ | |
| 목표 보기 | ✅ | ✅ | ✅ |
| 피드백 쓰기 | ✅ | ✅ | |
| 피드백 보기 | 전체(멤버별 거르기) | 전체(멤버별 거르기) | 나에게 온 것만 |

- 초대 코드는 받을 사람(이메일 또는 user_id)이 정해진 코드입니다. 다른 사람이 입력하면 서버가 거절합니다.
- 내보내기와 방장 넘기기는 한 번 더 확인한 뒤 실행합니다.
- 멤버 현황의 학습 기록은 그룹 가입 이후가 아니라 전체 기간 누적이고, "그룹 데이터 공유"를 끈 멤버는 0으로 나옵니다(서버 계산 방식).

## 세션 측정과 복구

로그인 후 [세션 시작]을 누르면 로컬 AI가 컴퓨터의 카메라를 엽니다. 처음 3초 동안 화면 중앙을 바라보세요. 보정 후 유효한 1분의 측정이 끝날 때마다 시선·눈·머리 점수와 판정이 표시됩니다. 점수 가중치는 시선 30%, 눈 50%, 머리 20%입니다. [웹캠 숨기기]를 눌러도 측정은 계속됩니다.

로컬 AI가 완성된 분을 SQLite에 보관하고 v2 로그로 전송합니다. [세션 종료]를 누르면 전송을 마친 뒤 리포트를 생성합니다. 화면 연결이 약 90초 동안 끊기면 카메라 측정을 멈춥니다. 같은 계정으로 세션 화면을 다시 열어 [이어하기] 또는 [종료하기]를 누를 수 있습니다. 다른 도구에서 연 세션은 해당 도구에서 마무리합니다. [연결·복구 절차](../docs/frontend-handoff.md)

## 기획서와 다르게 한 부분

| 기획서 | 현재 | 이유 |
| --- | --- | --- |
| 대시보드 최근 세션 카드 목록 | 없음 | 리포트 화면의 세션 목록과 겹침 |
| 리포트 "다음 학습 시작" / "대시보드로" 버튼 | 없음 | 위쪽 메뉴와 대시보드 고정 버튼으로 대신함 |
| 이탈 시 소리 **또는 진동** | 소리만 | 진동은 iPhone(Safari)에서 지원하지 않아 제외 |
| 눈 감지 시 팝업 가이드 | 연속 이탈 시 팝업 | 현재 안내는 분당 이탈 판정을 사용 |
| 글꼴 Noto Sans KR / Inter | 기기 기본 글꼴 | 별도 글꼴을 받지 않고 시스템 글꼴 사용 |
| 버튼·입력칸 모서리 12px | 8px (카드는 12px) | 디자인 판단으로 유지 |
| 회원가입 후 바로 사용 | 로그인 화면으로 이동 | 아래 "설계상 결정" 참고 |

## 미구현

- **백엔드 API가 없어 대기:** 세션 일시정지, 비밀번호 찾기, 알림 설정

## 백엔드에 요청한 API

아래 API가 없어도 화면은 우회 방법으로 동작합니다. 생기면 우회 화면을 줄이고 빠진 버튼을 넣을 수 있습니다. 경로는 제안이며 백엔드 규칙에 맞게 정합니다.

| 우선 | 요청 | 제안 형태 | 지금 프런트 동작 |
| --- | --- | --- | --- |
| 높음 | 받은 그룹 초대 목록 | `GET /api/groups/invitations` (나에게 온 PENDING 초대) | 초대 코드를 메신저로 전달하고 [초대 코드로 가입]에 입력 |
| 보통 | 친구 삭제 | `DELETE /api/connections/:connectionId` | 친구 목록에 [삭제] 없음 |
| 보통 | 공유 취소 | `DELETE /api/session-shares/:id` (올린 사람만) | 피드 내 글에 [삭제] 없음 |
| 보통 | 그룹 나가기 | 본인 내보내기 허용 또는 `POST /api/groups/:id/leave` | 일반 멤버용 [나가기] 없음 |
| 보통 | 목표 달성률 | goals 응답에 기간 내 학습 분·평균 점수 추가 | 목표 수치만 표시, 진행 막대 없음 |
| 보통 | 목표 수정·완료·삭제 | `PATCH`·`DELETE /api/groups/:id/goals/:goalId` | 목표가 계속 "진행 중" |
| 낮음 | 목표 담당자 명단 | goals 응답에 assignees(멤버 ID·닉네임) 추가 | 담당 인원 수만 표시, 이미 담당인 사람을 고르면 409로 안내 |
| 낮음 | 그룹 멤버 명단 | `GET /api/groups/:id/members` (멤버 누구나, 닉네임·역할만) | 일반 멤버는 "내 현황"만 |
| 낮음 | 공개 그룹 둘러보기·바로 가입 | `GET /api/groups/public`, 코드 없는 가입 | 공개 그룹도 초대 코드로만 가입 |
| 낮음 | 테스트용 시드 보강 | `seed.js`에 user_a 완료 세션 21개 이상 | [더 보기]·랭킹·피드를 직접 세션을 여러 번 만들어 확인 |

## 브라우저 검증 범위

`npm run verify:fe2`는 격리 환경의 Chromium에서 계정 8개로 인증, 대시보드·리포트, 점수·시간 공개 범위, 소셜·그룹 흐름을 확인합니다. LBE-4 카메라의 1분 집계 99.23점을 재생한 세션과 얼굴 미검출 테스트 입력 0점 세션을 사용합니다. 그룹에서는 생성·초대·가입, 매니저 승격, 역할별 멤버 목록, 목표·피드백 표시와 비구성원의 403 안내가 통과했습니다.

`npm run verify:fe4`에서 다음 항목을 검증합니다.

- **Roll-up 안내** — 격리 DB에서 45·120·400일 전 세션을 직접 집계한 뒤 리포트의 시간·일·주 단위 안내와 평균을 확인합니다.
- **목록 페이지네이션** — 완료 리포트와 친구 피드를 각각 20건과 3건으로 나누어 불러온 뒤 표시 순서와 중복·누락을 확인합니다.
- **측정과 화면** — 두 분의 로그 전송이 끊겼다가 복구되는 동안의 화면과 리포트를 대조합니다. 360×800과 1280×800에서 11개 화면을 열고 키보드 탐색과 저장된 닉네임·그룹 소개 표시를 확인합니다. 물리 카메라를 사용할 때는 `npm run verify:fe4 -- --live`로 실행합니다. [제품 E2E 시나리오](../docs/product-e2e-scenarios.md)

## 기술 스택

React 19, TypeScript, Vite, Tailwind CSS v4(`@tailwindcss/vite`), React Router v7, Chart.js(`react-chartjs-2`)

## 실행 방법

### 1. 백엔드 먼저 실행

`docs/setting-guide.md`를 따라 프로젝트 루트에서 백엔드를 실행합니다.

```bash
npm ci --prefix backend
npm run local:up
npm run local:seed          # 테스트 계정이 필요할 때만 실행
```

Node.js 22.x(22.13 이상)와 Docker Desktop이 필요합니다. `local:up`이 DB·Redis 준비 후 저장소 migration·조회 View를 적용합니다. 기존 환경 파일·볼륨과 시드 계정의 변경된 비밀번호를 유지합니다. 종료는 `npm run local:down`, 데이터 변경 전 백업은 `npm run local:backup`을 사용합니다. 일상 기동에 `migrate dev`, `db:reset`, `down -v`를 사용하지 않습니다.

`http://localhost:3000/health`가 200이면 준비된 것입니다.

### 2. 로컬 AI와 프런트엔드 실행

AI 의존성이 설치된 Python 3.11 환경을 준비한 뒤, 저장소 루트에서 별도 터미널로 AI를 실행합니다. 아래 경로는 프로젝트의 `.local/ai-venv`에 가상환경을 만든 경우입니다. 기존 Face Landmarker 모델을 사용하려면 `FOCUSLENS_MODEL_PATH`에 파일 경로를 지정합니다. [최초 설치와 카메라 설정](../docs/frontend-handoff.md)

```bash
export FOCUSLENS_AI_PYTHON="$PWD/.local/ai-venv/bin/python"
npm run local:ai:web
```

다른 터미널에서 프런트를 실행합니다.

```bash
cd frontend
# 선택: .env.development에 VITE_API_BASE_URL=http://localhost:3000 설정
# 기존 파일은 보존하며, 없으면 같은 기본값을 사용합니다.
npm ci
npm run dev -- --host localhost --port 5173 --strictPort
```

프런트와 API는 모두 `localhost`를 사용합니다. `127.0.0.1`과 섞으면 SameSite 쿠키와 CORS가 달라질 수 있습니다. 다른 포트를 쓰면 API의 `LOCAL_API_PORT`, 프런트 `VITE_API_BASE_URL`, Compose `LOCAL_CORS_ORIGIN`을 함께 맞추고 재기동합니다. 호스트에서 API를 직접 실행하는 경우에는 `backend/.env`의 `CORS_ORIGIN`을 사용합니다. `strictPort`는 허용하지 않은 5174로 자동 이동하는 것을 막습니다.

### 3. 테스트 계정 (시드 데이터)

| 이메일 | 비밀번호 | 비고 |
| --- | --- | --- |
| `user_a@focuslens.dev` | `password_a123!` | 일반 유저 |
| `user_b@focuslens.dev` | `password_b123!` | 일반 유저, A와 친구 관계 |
| `admin@focuslens.dev` | `password_admin123!` | 관리자, 스터디 그룹 OWNER |

시드 계정은 모두 **세션 비공개·랭킹 미참여**로 만들어집니다(새로 가입한 계정도 같음). 그대로면 공유·피드·랭킹이 비어 보이므로, 소셜 화면을 확인할 때는 각 계정 프로필에서 아래처럼 바꿉니다. 일부러 값을 다르게 두면 "비공개" 표시, 공유 범위 제한, 랭킹 제외, 그룹 현황 0 표시를 같이 확인할 수 있습니다.

| 계정 | 기본 세션 공개 범위 | 점수 공개 | 학습 시간 공개 | 그룹 데이터 공유 | 랭킹 참여 |
| --- | --- | --- | --- | --- | --- |
| user_a | PUBLIC | PUBLIC | PUBLIC | 켜기 | 켜기 |
| user_b | FRIENDS | FRIENDS | PRIVATE | 켜기 | 켜기 |
| admin | PUBLIC | PRIVATE | PRIVATE | 끄기 | 끄기 |

브라우저 하나에는 로그인이 하나뿐이라, 계정 여러 개는 일반 창·시크릿 창·다른 브라우저로 나눠 씁니다.

### 4. 측정 연결 검증

저장소 루트에서 `npm run verify:fe3`를 실행하면 격리된 브라우저·API·AI 실행기에서 테스트 카메라 입력으로 세션 시작·복구·종료와 점수 표시를 확인합니다. 개발 서버의 `/session?forceDistracted`에서는 완성된 분마다 이탈 알림을 시험할 수 있습니다. 점수 게이지·저장 로그·리포트에는 실제 측정값이 표시됩니다.

### 5. 소셜·그룹 핵심 흐름 테스트

계정 여러 개가 필요한 흐름입니다. 위 표대로 프로필을 바꾸고, 계정마다 세션을 2~3번(1~2분이면 충분) 완료한 뒤 진행합니다.

1. **공유·피드:** user_a로 리포트 → [공유하기] 전체 공개 → 피드 맨 위에 보이는지. user_b로 [공유하기]를 열면 "친구에게"만 고를 수 있는지. user_a 피드에서 user_b 글의 학습 시간이 "비공개"인지
2. **랭킹:** user_a로 친구 탭에 user_a·user_b만 나오는지. admin은 랭킹 참여가 꺼져 있어 어디에도 없고, admin 화면의 내 순위가 "기록 없음"인지
3. **친구:** admin으로 친구 화면 → user_b의 ID로 요청 → user_b로 [수락] → 서로 친구 목록에 보이는지
4. **그룹:** user_a로 그룹 만들기 → 초대(친구 중에서 user_b) → user_b로 코드 입력해 가입 → user_a가 user_b를 매니저로 바꾸면 user_b 화면에 전체 멤버 현황이 보이는지. 같은 코드를 admin이 넣으면 거절되는지
5. **목표·피드백:** user_a로 목표 만들기·담당 지정, user_b에게 피드백 → user_b 화면에서 "나에게 배정됨"과 피드백이 보이는지

### 6. 토큰 갱신 테스트

Access Token 수명이 1시간이라, 개발자 도구(F12) → Application에서 토큰을 일부러 망가뜨려 확인합니다.

| 상황 | 하는 방법 | 기대 결과 |
| --- | --- | --- |
| 정상 갱신 | Local Storage의 `access_token`을 `x`로 바꾸고 다른 메뉴로 이동 | 화면 정상, `access_token`이 새 값으로 바뀜 (Network: 401 → refresh 200 → 원래 요청 200) |
| 갱신 실패 | Cookies에서 Refresh Token 쿠키 삭제 + `access_token`을 `x`로 | `/login?expired=true`로 이동 |
| 네트워크 끊김 | Network 탭을 Offline으로 | "서버에 연결할 수 없습니다", 로그인 유지 |

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
| `VITE_LOCAL_AI_ORIGIN` | 로컬 AI의 HTTP 루프백 주소 | `http://127.0.0.1:4317` |

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
    ├── api.ts             # 백엔드 요청 및 인증 갱신
    ├── localAi.ts         # 로컬 AI 세션 제어·상태·미리보기
    ├── friends.ts         # 친구 관계 불러오기, 친구 요청 보내기
    ├── groups.ts          # 그룹 타입·역할 이름, 멤버 명단 불러오기
    ├── index.css          # Tailwind와 디자인 토큰(@theme), 인쇄 설정
    ├── pages/             # 주소가 있는 화면 11개
    └── components/        # 화면 안에 끼워 쓰는 조각
        ├── ShareDialog.tsx    # 세션 공유 창
        ├── FriendButton.tsx   # [+ 친구] 버튼 (피드·랭킹)
        └── group/             # 그룹 상세의 탭: 멤버(초대 포함)·목표·피드백
```

## 설계상 결정 사항

**공통 API 클라이언트 (`src/api.ts`)**
- 백엔드 요청은 `apiFetch(path, options)`에서 주소, Bearer 헤더와 쿠키 전송을 처리합니다. 로컬 AI 요청에는 Bearer만 보내고 인증 갱신은 백엔드 API에 보냅니다.
- **401:** Refresh Token(HttpOnly 쿠키)으로 한 번 갱신한 뒤 원래 요청을 한 번 다시 보냅니다. Refresh Token이 무효(만료·폐기)일 때만 `/login?expired=true`로 이동합니다(`docs/auth-flow.md` 7절). 서버 장애(5xx)나 네트워크 끊김으로 갱신하지 못하면 로그아웃하지 않고 화면에 오류 문구를 보여 줍니다. 잠깐의 장애로 로그인이 풀리지 않게 하기 위해서입니다. 여러 요청이 동시에 401을 받아도 갱신은 한 번만 합니다. 같은 Refresh Token을 두 번 쓰면 서버가 재사용으로 판단해 로그인 전체를 폐기하기 때문입니다.
- 로그인·회원가입·로그아웃은 `skipAuthRefresh: true`로 갱신을 건너뜁니다. 여기서 받는 401은 만료가 아니라 인증 실패이기 때문입니다.
- **오류 문구:** `getErrorMessage()`가 상태 코드별 문구를 만듭니다. 400·409는 서버 문구를 그대로 쓰고, 403은 권한 안내를, 500·503은 `X-Request-ID`를 함께 보여줍니다(`docs/frontend-api-map.md` 2·3절). 데이터를 불러오는 화면에는 [다시 시도] 버튼이 있습니다.

**화면 동작**
- 회원가입 후에는 **자동 로그인하지 않고** 로그인 화면으로 이동합니다. 사용자는 방금 만든 계정으로 로그인합니다.
- 진행 중인 본인 AI 세션을 다시 열면 화면과 타이머를 복원합니다. 경과 시간은 서버의 `started_at`부터 계산하므로 카메라가 일시 중단된 시간도 포함됩니다.
- 평균 점수 등이 `null`이면 0이 아니라 "기록 없음"으로 표시합니다(`docs/frontend-api-map.md` 2절). 차트에서도 기록 없는 날은 0으로 그리지 않고 건너뜁니다.
- Chart.js 차트는 부모에 고정 높이(`h-64`)를 주고 `maintainAspectRatio: false`를 씁니다. 이렇게 하지 않으면 좁은 화면에서 가로로 넘칩니다.
