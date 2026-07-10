FROM node:20-slim

# Prisma 엔진 구동에 필요한 OpenSSL 설치
RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

# 의존성 먼저 복사 (레이어 캐시 활용)
COPY package*.json ./

RUN npm ci --omit=dev

# 소스 복사
COPY . .

EXPOSE 3000

# 런타임에 볼륨으로 마운트된 스키마를 읽어 클라이언트 생성 후 서버 시작
CMD ["sh", "-c", "npx prisma generate --schema=prisma/schema.prisma && node server.js"]
