# PTS-2 simulator image for compose / load tests (build context: repo root).
# tools/pts-simulator has no Dockerfile of its own; this one builds
# @fms/shared first because the simulator links it with file:../../packages/shared.
FROM node:20-alpine
WORKDIR /app
COPY packages/shared packages/shared
RUN cd packages/shared && (npm ci || npm install) && npm run build
COPY tools/pts-simulator tools/pts-simulator
RUN cd tools/pts-simulator && (npm ci || npm install) && npm run build --if-present
WORKDIR /app/tools/pts-simulator
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
