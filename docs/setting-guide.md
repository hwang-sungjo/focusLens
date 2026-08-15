# 🚀 Phase 2 백엔드 환경 구축 완료 안내 (팀 공유용)

백엔드 인프라(Docker, DB, Redis, 기본 서버 구조) 구축이 완료되었습니다.
프런트엔드 및 AI 개발자분들은 아래 가이드에 따라 로컬 개발 환경을 세팅해 주시기 바랍니다.

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
   # 프로젝트 루트 디렉토리에서 순차적으로 실행
   npm run db:migrate          # 로컬 개발 DB 스키마 적용
   npm run db:migrate:deploy # 공유/배포 환경에서 미적용 migration 적용
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
   - **Health Check API:** `GET /health` (응답 200, `db`, `redis` connected 상태 확인 가능)
   - **CORS 설정:** 기본적으로 `http://localhost:5173` 에서의 요청을 허용하도록 설정되어 있습니다. (Vite 기본 포트) 다른 포트 사용 시 `backend/.env` 의 `CORS_ORIGIN`을 수정해 주세요.

2. **API 라우터 기본 구조**
   - 아래 도메인별 라우터가 마운트되어 있습니다. 상세 스펙이 구현되는 대로 바로 연동하실 수 있습니다.
     - `/api/auth`: 로그인, 토큰 재발급 등
     - `/api/sessions`: 집중 세션 시작/종료
     - `/api/reports`: 세션 요약 리포트
     - `/api/users`: 프로필, 설정 조회
     - `/api/connections`: 친구 요청/수락
     - `/api/session-shares`: 피드 공유 및 공감
     - `/api/rankings`: 랭킹 조회
     - `/api/groups`: 그룹 생성, 관리

3. **인증 (Authentication)**
   - API 연동 시 JWT Access Token을 `Authorization: Bearer <token>` 헤더에 담아 전송해야 합니다.

---

## 🤖 AI 개발 팀 전달 사항

1. **AI 추론 결과 저장 테이블 (`concentration_logs`)**
   - AI 모델이 계산한 집중도 점수는 `concentration_logs` 테이블에 저장됩니다.
   - **제약 조건:** `focus_score`, `gaze_score`, `blink_score`, `head_score`는 모두 `0` 이상 `100` 이하의 Float 값이어야 합니다.
   - **상태 값:** `attention_state` 컬럼은 `FOCUSED`, `NORMAL`, `DISTRACTED` 세 가지 Enum 값만 허용됩니다.

2. **파생 데이터(통계, 랭킹) 조회 원칙**
   - 평균 집중도, 총 학습 시간 등의 집계 데이터는 기본 테이블에 저장하지 않고 **미리 생성된 View를 통해 조회**합니다. AI 모델 결과 평가나 통계 추출 시 아래 View를 활용해 주세요.
     - `v_user_session_summaries`: 개별 세션의 평균 집중도 및 시간 요약
     - `v_group_member_stats`: 그룹 멤버별 기간 내 누적 통계
     - `v_rankings`: 참여자 전체 랭킹 조회 (프라이버시 설정이 반영된 뷰)

3. **DB 접속 정보**
   - 로컬 DB 도구(DBeaver, DataGrip 등) 접속 주소:
     `postgresql://focuslens:focuslens_pw@localhost:5432/focuslens?schema=public`
