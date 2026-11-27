# Build context = repository root:
#   docker build -f services/ingest-api/Dockerfile -t fms/ingest-api .

FROM node:20-alpine AS build
WORKDIR /app
# shared contracts package
COPY packages/shared/package.json packages/shared/package-lock.json* packages/shared/tsconfig.json packages/shared/
RUN cd packages/shared && npm ci --no-audit --no-fund
COPY packages/shared/src packages/shared/src
COPY tsconfig.base.json ./
RUN cd packages/shared && npm run build
# service
COPY services/ingest-api/package.json services/ingest-api/package-lock.json services/ingest-api/
RUN cd services/ingest-api && npm ci --no-audit --no-fund
COPY services/ingest-api/tsconfig.json services/ingest-api/
COPY services/ingest-api/src services/ingest-api/src
RUN cd services/ingest-api && npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8081
WORKDIR /app
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY services/ingest-api/package.json services/ingest-api/package-lock.json services/ingest-api/
RUN cd services/ingest-api && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/services/ingest-api/dist services/ingest-api/dist
USER node
WORKDIR /app/services/ingest-api
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
# SIGTERM -> graceful drain (app.close + pool.end)
CMD ["node", "dist/server.js"]
