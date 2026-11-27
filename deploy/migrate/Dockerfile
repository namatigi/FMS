# Migration runner image (build context: repo root).
#   docker build -f deploy/migrate/Dockerfile -t fms/migrate .
#   docker run --rm -e DATABASE_URL=postgres://... fms/migrate            # schema only
#   docker run --rm -e DATABASE_URL=postgres://... fms/migrate --seed     # + demo seed (dev only)
# db/migrate.mjs takes a Postgres advisory lock, so running it from several
# pods at once is safe. Always point it at the primary directly (NOT through
# PgBouncer in transaction mode: session advisory locks need a session).
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY db ./db
USER node
ENTRYPOINT ["node", "db/migrate.mjs"]
