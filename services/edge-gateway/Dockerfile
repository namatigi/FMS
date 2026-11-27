# syntax=docker/dockerfile:1.6
# Build context = REPO ROOT:
#   docker build -f services/edge-gateway/Dockerfile -t fms/edge-gateway .
# services/edge-gateway/Dockerfile.dockerignore is picked up automatically by BuildKit.
FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN cd packages/shared && npm install --no-audit --no-fund && npm run build
COPY packages/zra-client packages/zra-client
RUN cd packages/zra-client && npm install --no-audit --no-fund && npm run build
COPY packages/fiscal-printer packages/fiscal-printer
RUN cd packages/fiscal-printer && npm install --no-audit --no-fund && npm run build
# dev dependency of the gateway (tests); not shipped in the runtime image
COPY tools/pts-simulator tools/pts-simulator
RUN cd tools/pts-simulator && npm install --no-audit --no-fund && npm run build
COPY services/edge-gateway services/edge-gateway
RUN cd services/edge-gateway && npm install --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production EDGE_PTS_PORT=8100 EDGE_UI_PORT=8101
# file: dependencies are symlinks into ../../packages, so keep the repo layout
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/edge-gateway/package.json /repo/services/edge-gateway/package.json
COPY --from=build /repo/services/edge-gateway/node_modules /repo/services/edge-gateway/node_modules
COPY --from=build /repo/services/edge-gateway/dist /repo/services/edge-gateway/dist
COPY --from=build /repo/services/edge-gateway/migrations /repo/services/edge-gateway/migrations
WORKDIR /repo/services/edge-gateway
USER node
EXPOSE 8100 8101
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.EDGE_UI_PORT||8101)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
