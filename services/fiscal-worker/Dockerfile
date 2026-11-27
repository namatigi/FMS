# syntax=docker/dockerfile:1.7
# FMS fiscal-worker. Build context = REPO ROOT:
#   docker build -f services/fiscal-worker/Dockerfile -t fms/fiscal-worker .
# The same image can run the mock VSDC (dev only):
#   docker run --rm -p 8200:8200 fms/fiscal-worker node packages/zra-client/bin/mock-vsdc.js

# ---------------------------------------------------------------- build
FROM node:20-alpine AS build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false

COPY tsconfig.base.json ./
# Manifests first for layer caching. Each package is standalone (no workspaces);
# file: dependencies resolve to sibling directories, so keep the repo layout.
COPY packages/shared/package.json packages/shared/package-lock.json* packages/shared/
COPY packages/zra-client/package.json packages/zra-client/package-lock.json* packages/zra-client/
COPY packages/fiscal-printer/package.json packages/fiscal-printer/package-lock.json* packages/fiscal-printer/
COPY services/fiscal-worker/package.json services/fiscal-worker/package-lock.json* services/fiscal-worker/
RUN set -e; for d in packages/shared packages/zra-client packages/fiscal-printer services/fiscal-worker; do \
      (cd "$d" && if [ -f package-lock.json ]; then npm ci; else npm install; fi); \
    done

COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/zra-client/tsconfig.json packages/zra-client/
COPY packages/zra-client/src packages/zra-client/src
COPY packages/zra-client/bin packages/zra-client/bin
COPY packages/fiscal-printer/tsconfig.json packages/fiscal-printer/
COPY packages/fiscal-printer/src packages/fiscal-printer/src
COPY services/fiscal-worker/tsconfig.json services/fiscal-worker/
COPY services/fiscal-worker/src services/fiscal-worker/src

RUN set -e; for d in packages/shared packages/zra-client packages/fiscal-printer services/fiscal-worker; do \
      (cd "$d" && rm -rf dist && npx tsc -p tsconfig.json && npm prune --omit=dev); \
    done \
 && find packages/*/dist services/fiscal-worker/dist -type f -name '*.test.*' -delete \
 && rm -rf services/fiscal-worker/dist/test

# ---------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini \
 && mkdir -p /data/exports /data/receipts && chown -R node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    METRICS_PORT=9464 \
    EXPORT_DIR=/data/exports

# Copy each package (manifest + dist + production node_modules). npm's file: links
# are relative symlinks, preserved by COPY, so the repo layout is kept.
COPY --from=build --chown=node:node /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build --chown=node:node /app/packages/zra-client/package.json /app/packages/zra-client/package.json
COPY --from=build --chown=node:node /app/packages/zra-client/dist /app/packages/zra-client/dist
COPY --from=build --chown=node:node /app/packages/zra-client/bin /app/packages/zra-client/bin
COPY --from=build --chown=node:node /app/packages/zra-client/node_modules /app/packages/zra-client/node_modules
COPY --from=build --chown=node:node /app/packages/fiscal-printer/package.json /app/packages/fiscal-printer/package.json
COPY --from=build --chown=node:node /app/packages/fiscal-printer/dist /app/packages/fiscal-printer/dist
COPY --from=build --chown=node:node /app/packages/fiscal-printer/node_modules /app/packages/fiscal-printer/node_modules
COPY --from=build --chown=node:node /app/services/fiscal-worker/package.json /app/services/fiscal-worker/package.json
COPY --from=build --chown=node:node /app/services/fiscal-worker/dist /app/services/fiscal-worker/dist
COPY --from=build --chown=node:node /app/services/fiscal-worker/node_modules /app/services/fiscal-worker/node_modules

USER node
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${METRICS_PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/fiscal-worker/dist/main.js"]
