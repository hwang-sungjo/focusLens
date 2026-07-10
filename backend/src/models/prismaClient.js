// src/models/prismaClient.js
// Prisma Client 싱글턴 초기화 — 모든 DB 접근은 이 인스턴스를 통해 수행
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
});

module.exports = prisma;
