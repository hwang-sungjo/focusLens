# 🚀 Phase 2 백엔드 환경 구축 완료 안내 (팀 공유용)

백엔드 인프라(Docker, DB, Redis, 기본 서버 구조) 구축이 완료되었습니다.
프런트엔드 및 AI 개발자분들은 아래 가이드에 따라 로컬 개발 환경을 세팅해 주시기 바랍니다.

현재 백엔드는 인증·세션·리포트·프로필·친구·공유·랭킹·그룹의 36개 API operation, Prisma 모델 16개와 조회 View 4개를 구현했다. `npm test -- --runInBand`의 mock 기반 Jest 19개 테스트는 2026-09-22 점검에서 통과했다. AI는 프레임 특징 추출 단계이며 자동 로그 전송은 미연결이다. 운영 배포와 Roll-up은 `docs/backend-plan.md` Phase 4·5의 미완료 작업이다.

---

## 🛠️ 공통: 로컬 환경 세팅 방법

모든 팀원은 동일한 환경에서 개발을 진행하기 위해 아래 단계를 수행해야 합니다. (Docker Desktop 필수)

1. **환경변수 세팅**

   실행 환경에 맞는 템플릿 하나를 `backend/.env`로 복사합니다. 실제 `.env` 파일과 비밀값은 Git에 커밋하지 않습니다.

   ```bash
   cd backend

   # 개인 로컬 환경
   cp .env.local.example .env

   # 팀 개발 환경에서는 아래 템플릿을 사용하고 실제 개발 서버 주소로 수정
   # cp .env.development.example .env
   ```

   | 환경 | 템플릿 | 관리 원칙 |
   | --- | --- | --- |
   | 로컬 | `.env.local.example` | localhost 기반, 개인별 `.env`로 복사 |
   | 개발 | `.env.development.example` | 개발 DB·Redis·프런트 주소로 교체 |
   | 프로덕션 | `.env.production.example` | 키 목록만 참고하고 실제 값은 배포 Secret으로 주입 |

2. **Docker 컨테이너 실행 (DB, Redis, Backend)**
   ```bash
   # 프로젝트 루트 디렉토리에서 실행
   docker compose up -d --build
   ```

3. **DB 마이그레이션 및 초기 데이터(Seed) 세팅**
   ```bash
   # 프로젝트 루트 디렉토리에서 실행; 마이그레이션 명령은 환경에 맞는 하나만 선택
   npm run db:migrate          # 로컬 개발 DB 스키마 적용
   # npm run db:migrate:deploy # 공유/배포 환경에서 미적용 migration 적용
   npm run db:views            # 통계용 View 생성
   npm run db:seed             # 테스트 데이터 삽입
   ```

4. **테스트 계정 정보 (Seed 데이터)**
   - `user_a@focuslens.dev` / `password_a123!` (일반 유저)
   - `user_b@focuslens.dev` / `password_b123!` (일반 유저, A와 친구 관계)
   - `admin@focuslens.dev` / `password_admin123!` (관리자, 스터디 그룹 OWNER)

---

## 💻 프런트엔드 (Frontend) 팀 전달 사항

1. **API 서버 정보**
   - **Base URL:** `http://localhost:3000`
   - **Health Check API:** `GET /health` (DB·Redis 모두 연결 시 200, 하나라도 끊기면 503)
   - **CORS 설정:** 로컬 `.env` 예시는 `CORS_ORIGIN=http://localhost:5173`을 사용한다. 값을 설정하지 않으면 현재 서버 코드의 기본 origin은 `*`이다. 다른 포트 사용 시 `backend/.env`의 `CORS_ORIGIN`을 수정한다.

2. **API 라우터 기본 구조**
   - 구현된 라우터: `/api/auth`(회원가입·로그인·로그아웃), `/api/sessions`(시작·로그·종료·조회), `/api/reports`(세션별·주간·월간), `/api/users`(프로필·프라이버시), `/api/connections`(친구 요청·응답·조회), `/api/session-shares`(공유·피드·공감), `/api/rankings`, `/api/groups`(그룹·초대·멤버·목표·피드백).
   - 상세 요청·응답은 `docs/api-spec.md`, 실행 가능한 OpenAPI 문서는 `http://localhost:3000/api-docs/`에서 확인한다. Refresh Token 또는 토큰 재발급 라우트는 없다.

3. **인증 (Authentication)**
   - API 연동 시 JWT Access Token을 `Authorization: Bearer <token>` 헤더에 담아 전송해야 합니다.

---

## 🤖 AI 개발 팀 전달 사항

### 현재 AI 실행 프로그램 (2026-09-22)

`ai/`에는 Python 3.11 기반 로컬 웹캠 측정 프로그램이 구현돼 있다. OpenCV와 MediaPipe Face Landmarker로 약 10 FPS의 프레임을 처리하며, 얼굴 검출, 홍채 상대 위치, blink blendshape·단일 프레임 눈 감김, yaw/pitch/roll을 출력한다. 디버그 화면과 프레임별 JSON 출력이 가능하다. 진행 상태는 `docs/backend-plan.md`의 AI 현황표를 기준으로 하고, 실행 세부 사항은 `ai/README.md`를 참조한다.

```bash
cd ai
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
focuslens-ai --print-values
```

첫 실행 시 Face Landmarker 모델을 `ai/models/face_landmarker.task`로 내려받는다. 미리보기 창은 `q` 또는 `ESC`로 닫는다. `FOCUSLENS_MODEL_PATH`로 모델 경로를 바꿀 수 있다.

현재 `total` 계산 함수와 JWT 로그 API 클라이언트는 구현돼 있지만, 사용자별 보정·blink 이벤트·1분 점수 집계와 웹캠→API 전송 연결은 아직 없다. `FOCUSLENS_API_BASE_URL`, `FOCUSLENS_ACCESS_TOKEN`은 후속 연동용이며 현재 `focuslens-ai` 실행 명령은 이를 사용해 로그를 자동 전송하지 않는다.

1. **AI 추론 결과 저장 테이블 (`concentration_logs`)**
   - AI의 1분 점수 집계와 자동 전송이 완성되면 결과는 백엔드 API를 거쳐 `concentration_logs` 테이블에 저장된다. 현재 테이블과 수신 API는 구현됐지만 AI 자동 전송은 미연결이다.
   - **제약 조건:** `focus_score`, `gaze_score`, `blink_score`, `head_score`는 모두 `0` 이상 `100` 이하의 Float 값이어야 합니다.
   - **상태 값:** `attention_state` 컬럼은 `FOCUSED`, `NORMAL`, `DISTRACTED` 세 가지 Enum 값만 허용됩니다.
   - DB 저장은 백엔드의 `POST /api/sessions/:id/log`를 통해 수행한다. 요청에는 JWT와 `gaze`, `blink`, `head`, `total`, 선택적 `face_detected`를 보낸다. `total`은 0.4/0.3/0.3 가중 합산값이어야 하며, 현재 백엔드는 수신 시각을 `logged_at`으로 저장하고 동일 세션 60초 미만 전송을 차단한다. 현재 AI 실행 프로그램은 아직 이 요청을 자동으로 보내지 않는다.

2. **파생 데이터(통계, 랭킹) 조회 원칙**
   - 평균 집중도, 총 학습 시간 등의 집계 데이터는 기본 테이블에 저장하지 않고 **미리 생성된 View를 통해 조회**합니다. AI 모델 결과 평가나 통계 추출 시 아래 View를 활용해 주세요.
     - `v_user_session_summaries`: 개별 세션의 평균 집중도 및 시간 요약
     - `v_group_member_stats`: 그룹 멤버별 기간 내 누적 통계
     - `v_rankings`: 참여자 전체 랭킹 조회 (프라이버시 설정이 반영된 뷰)

3. **DB 접속 정보**
   - 로컬 DB 도구(DBeaver, DataGrip 등) 접속 주소:
     `postgresql://focuslens:focuslens_pw@localhost:5432/focuslens?schema=public`
