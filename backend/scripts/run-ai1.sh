#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
prisma=backend/node_modules/.bin/prisma
if [[ ! -x "$prisma" ]]; then
  echo 'Install the backend dependencies first: npm ci --prefix backend' >&2
  exit 1
fi

project="focuslens-ai1-$(node -p "require('node:crypto').randomUUID()")"
export AI1_PG_PASSWORD
AI1_PG_PASSWORD=$(node -p "require('node:crypto').randomBytes(24).toString('hex')")
compose=(docker compose -p "$project" -f backend/scripts/ai1.compose.yml)
# Resolve @prisma/client from backend/node_modules for this repository's root-level schema.
schema_dir=$(mktemp -d backend/node_modules/.ai1-schema-XXXXXX)
cleanup() {
  local result=$?
  "${compose[@]}" down --volumes || result=1
  rm -f "$schema_dir/schema.prisma"
  rmdir "$schema_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d --wait --wait-timeout 60
pg_addr=$("${compose[@]}" port postgres 5432)
redis_addr=$("${compose[@]}" port redis 6379)
export AI1_DATABASE_URL="postgresql://postgres:${AI1_PG_PASSWORD}@${pg_addr}/focuslens_ai1"
export AI1_REDIS_URL="redis://${redis_addr}"
export DATABASE_URL="$AI1_DATABASE_URL"

cp prisma/schema.prisma "$schema_dir/schema.prisma"
PRISMA_GENERATE_SKIP_AUTOINSTALL=true "$prisma" generate --schema "$schema_dir/schema.prisma"
"$prisma" migrate deploy --schema prisma/schema.prisma
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d focuslens_ai1 < prisma/views.sql
node backend/scripts/verify-ai1-log-v2.js "$@"
