#!/bin/sh
set -eu

/app/node_modules/.bin/prisma migrate deploy --schema=/app/prisma/schema.prisma
/app/node_modules/.bin/prisma db execute --schema=/app/prisma/schema.prisma --file=/app/prisma/views.sql
