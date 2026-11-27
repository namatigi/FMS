# Build context = repository root:
#   docker build -f services/core-api/Dockerfile -t fms/core-api .
FROM node:20-alpine AS build
WORKDIR /repo

# shared package
COPY packages/shared/package.json packages/shared/package-lock.json* packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY tsconfig.base.json ./
RUN cd packages/shared && npm install --no-audit --no-fund && npm run build

# service
COPY services/core-api/package.json services/core-api/package-lock.json* services/core-api/
RUN cd services/core-api && npm ci --no-audit --no-fund
COPY services/core-api/tsconfig.json services/core-api/
COPY services/core-api/src services/core-api/src
RUN cd services/core-api && npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /repo
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build --chown=node:node /repo/services/core-api/package.json /repo/services/core-api/package.json
COPY --from=build --chown=node:node /repo/services/core-api/node_modules /repo/services/core-api/node_modules
COPY --from=build --chown=node:node /repo/services/core-api/dist /repo/services/core-api/dist
COPY --chown=node:node services/core-api/migrations /repo/services/core-api/migrations
WORKDIR /repo/services/core-api
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
