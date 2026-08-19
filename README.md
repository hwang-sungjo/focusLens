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

### architecture
```
src/
  routes/         auth.js, sessions.js, reports.js,
                  users.js, connections.js, sessionShares.js,
                  rankings.js, groups.js
  controllers/    (각 라우트에 대응하는 파일)
  middleware/     auth.js (JWT 검증), errorHandler.js, validate.js
  models/         (Prisma client 초기화)
  services/       redis.js
  utils/          focusScore.js (집중도 알고리즘)

루트:
  app.js          (라우터 마운트, 미들웨어 등록)
  server.js       (포트 리스닝)
  package.json    (express, @prisma/client, jsonwebtoken,
                   bcrypt, ioredis, dotenv 의존성 포함)
```
