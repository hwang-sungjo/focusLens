# FocusLens Git 컨벤션

팀 공통 Git 브랜치 전략, PR 규칙, 커밋 메시지 형식을 정의한다.

---

## 1. 브랜치 전략

| 브랜치 | 용도 | 기준 브랜치 |
| --- | --- | --- |
| `main` | 프로덕션 배포용. 항상 배포 가능한 상태 유지 | — |
| `develop` | 백엔드 개발 브랜치. 기능 개발 완료 후 병합 | `main` |
| `uiux` | 프런트엔드 개발 브랜치. 기능 개발 완료 후 병합 | `main` |
| `ai` | ai 개발 브랜치. 기능 개발 완료 후 병합 | `main` |
| `feature/xxx` | 기능 단위 개발 | `각각의 개발 브랜치` |
| `hotfix/xxx` | 프로덕션 긴급 수정 | `main` |

### 브랜치 흐름

```
main ─────────────────────────────────────► (배포)
  │                    ▲
  │                    │ hotfix/xxx (PR → main, 이후 develop 동기화)
  ▼                    │
develop ─────────────────────────────────► (통합)
  │
  ├── feature/auth-login
  ├── feature/session-start
  └── feature/group-invite
```

### feature 브랜치 네이밍

형식: `feature/{도메인}-{기능}` (kebab-case)

| 예시 | 설명 |
| --- | --- |
| `feature/auth-login` | 로그인 API |
| `feature/session-start` | 세션 시작 API |
| `feature/group-invite` | 그룹 초대 API |

### hotfix 브랜치 네이밍

형식: `hotfix/{이슈-요약}` (kebab-case)

| 예시 | 설명 |
| --- | --- |
| `hotfix/login-token-expiry` | 로그인 토큰 만료 버그 수정 |
| `hotfix/session-log-validation` | 집중도 로그 검증 오류 수정 |

---

## 2. 브랜치 보호 규칙

| 브랜치 | 직접 push | 병합 방법 |
| --- | --- | --- |
| `main` | **금지** | PR + squash merge만 허용 |
| `develop` | **금지** | PR + squash merge만 허용 |
| `feature/*`, `hotfix/*` | 허용 | PR을 통해 상위 브랜치로 병합 |

- `main`, `develop`에는 **직접 push하지 않는다.**
- 모든 변경은 Pull Request를 통해 반영한다.
- `hotfix`는 `main`에 먼저 병합한 뒤, `develop`에도 동기화(cherry-pick 또는 merge)한다.

---

## 3. PR 규칙

| 항목 | 규칙 |
| --- | --- |
| **리뷰** | **1인 리뷰 필수** — 최소 1명 Approve 후 merge |
| **병합 방식** | **Squash merge** 사용 |
| **PR 제목** | squash 후 커밋 메시지가 되므로 [커밋 컨벤션](#4-커밋-메시지-컨벤션) prefix 준수 |
| **PR 본문** | 변경 요약, 테스트 방법, 관련 이슈 번호 포함 |

### PR 대상 브랜치

| 소스 브랜치 | 대상 브랜치 |
| --- | --- |
| `feature/*` | `각각의 개발 브랜치` |
| `hotfix/*` | `main` (이후 `개발 브랜치` 동기화) |
| `개발 브랜치` (릴리스) | `main` |

### Squash merge 커밋 메시지 예시

```
feat: add session start API

- POST /api/sessions/start 구현
- JWT 인증 미들웨어 적용
```

---

## 4. 커밋 메시지 컨벤션

형식: `{prefix}: {간결한 설명}`

| prefix | 용도 |
| --- | --- |
| `feat` | 새 기능 추가 |
| `fix` | 버그 수정 |
| `docs` | 문서 변경 |
| `refactor` | 리팩터링 (기능 변경 없음) |
| `test` | 테스트 추가·수정 |
| `chore` | 빌드, 설정, 의존성 등 기타 작업 |

### 예시

```
feat: add JWT login endpoint
fix: reject duplicate concentration log within 1 minute
docs: add API spec for group endpoints
refactor: extract focus score validation to middleware
test: add unit tests for focusScore util
chore: configure jest in package.json
```

### 작성 원칙

- 제목은 **50자 이내**, 명령형 현재 시제 사용 (`add`, `fix`, `update`)
- 본문이 필요하면 제목과 빈 줄 뒤에 상세 설명 작성
- 하나의 커밋은 **하나의 논리적 변경**만 포함

---

## 5. 작업 흐름 요약 (예시)

1. `develop`에서 `feature/xxx` 브랜치 생성
2. 작업 후 커밋 (prefix 컨벤션 준수)
3. `develop` 대상 PR 생성 → **1인 리뷰** → **squash merge**
4. 릴리스 시 `develop` → `main` PR
5. 긴급 수정 시 `main`에서 `hotfix/xxx` 생성 → `main` PR → `develop` 동기화
