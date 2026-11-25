FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build

COPY backend/package.json backend/package-lock.json ./
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true npm ci

COPY prisma ./prisma
RUN ./node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma

COPY backend/app.js backend/server.js ./backend/
COPY backend/src ./backend/src
COPY backend/scripts/rollup.js ./backend/scripts/rollup.js
COPY backend/scripts/init-db.sh ./backend/scripts/init-db.sh
COPY docs/swagger.yaml ./docs/swagger.yaml

# Migration jobs use the same locked Prisma version that generated the client.
FROM build AS migration
USER node
ENTRYPOINT ["sh", "/app/backend/scripts/init-db.sh"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend ./backend
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/docs ./docs

WORKDIR /app/backend
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
