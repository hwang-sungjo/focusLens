# focusLens

## Backend

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