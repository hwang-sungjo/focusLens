# focusLens

## Backend

### 실행 및 API 문서

로컬 실행 시 Node.js 20 이상이 필요하며, Docker 실행은 프로젝트의 Node.js 20 이미지를 사용한다.

```bash
docker compose up -d --build
```

- Swagger UI: `http://localhost:3000/api-docs/`
- OpenAPI JSON: `http://localhost:3000/api-docs/openapi.json`
- Health check: `http://localhost:3000/health`

Swagger UI의 `Authorize` 버튼에 로그인 응답의 `access_token`을 입력하면 보호된 API를 브라우저에서 직접 호출할 수 있다.

### 프로젝트 아키텍처

```text
focusLens/
├── backend/                         # Express API 애플리케이션
│   ├── app.js                       # 미들웨어, 라우터, Health Check, Swagger UI
│   ├── server.js                    # HTTP 서버 진입점
│   ├── Dockerfile
│   ├── package.json                 # 백엔드 런타임·Prisma 의존성
│   └── src/
│       ├── routes/                  # API 경로·입력 검증·JWT 적용
│       ├── controllers/             # 도메인별 요청 처리와 비즈니스 로직
│       ├── middleware/              # 인증, 검증 결과, 전역 오류 처리
│       ├── models/prismaClient.js   # Prisma Client 싱글턴
│       ├── services/redis.js        # 토큰 블랙리스트·로그 전송 제한
│       └── utils/focusScore.js      # 집중도 계산·평균·상태 판정
├── prisma/
│   ├── schema.prisma                # 16개 도메인 모델
│   ├── migrations/                  # DB 스키마·제약·View 마이그레이션
│   ├── views.sql                    # 통계 View 재적용 스크립트
│   └── seed.js                      # 개발용 시드 데이터
├── src/                             # Jest 테스트
│   ├── controllers/                 # 컨트롤러 단위 테스트
│   └── utils/                       # 실제 백엔드 유틸 단위 테스트
├── docs/                            # 기획, ERD, API, 보안, 운영 문서
│   └── swagger.yaml                 # Swagger UI가 사용하는 OpenAPI 단일 원본
├── docker-compose.yml               # API·PostgreSQL·Redis 실행 구성
└── package.json                     # 테스트와 DB 작업용 루트 명령
```

요청은 `route → middleware → controller → Prisma/Redis` 순서로 처리된다. PostgreSQL의 View는 리포트·랭킹·그룹 대시보드 집계에 사용되며, 파생 값은 기본 테이블에 저장하지 않는다.
