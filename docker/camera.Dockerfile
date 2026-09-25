# syntax=docker/dockerfile:1

# The camera service, built off-box the same way as docker/Dockerfile - see
# that file's header for why (never build on the deployment host, a
# read-only root filesystem on Luke).
#
# Unlike the server, this image has NO native dependencies at all - no
# node:sqlite, nothing native-built by pnpm - so unlike docker/Dockerfile it
# is genuinely multi-arch: linux/amd64 and linux/arm64 both build cleanly with
# `docker buildx build --platform linux/amd64,linux/arm64`. That matters
# because the camera service is moving off phi (a Mac, arm64) onto Rey
# (Ubuntu, likely amd64) - see the README's "The camera" section - and, unlike
# the server, it currently runs NATIVELY rather than in a container. This
# Dockerfile is what lets that change without also changing the image.

FROM node:25-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# See docker/Dockerfile for why corepack needs installing explicitly and
# --force is needed.
RUN npm install -g --force corepack@latest && corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdcp/package.json packages/sdcp/
COPY packages/camera/package.json packages/camera/
COPY packages/goo/package.json packages/goo/
COPY packages/fake-printer/package.json packages/fake-printer/
COPY apps/server/package.json apps/server/
COPY apps/camera/package.json apps/camera/
COPY apps/web/package.json apps/web/
COPY infra/package.json infra/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @cthulhu/camera build \
 && pnpm --filter @cthulhu/camera-service build

# Same trick as the server image: a self-contained, production-only tree,
# rather than shipping the whole workspace's build tooling.
RUN pnpm --filter @cthulhu/camera-service deploy --prod --legacy /prod/camera

# ---- runtime ----------------------------------------------------------------
FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg does the actual RTSP-to-MJPEG transcoding - the entire point of this
# service. Debian's build picks CPU features at runtime, so it is safe on
# Luke's old Turion II (no AVX) too, should this ever need to run there.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /prod/camera/node_modules ./node_modules
COPY --from=build /prod/camera/dist ./dist
COPY --from=build /prod/camera/package.json ./

# Docker seeds a new named volume from the image's directory, ownership
# included. Without these the volumes come up root-owned, and the first write
# as node fails with EACCES: on phi that crash-looped the camera service
# mid-print and wedged the printer's RTSP until a power cycle (CTHU-22).
RUN mkdir -p /timelapse && chown node:node /timelapse

EXPOSE 9121
USER node
CMD ["node", "dist/index.js"]
