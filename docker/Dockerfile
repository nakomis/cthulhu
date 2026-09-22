# syntax=docker/dockerfile:1

# Built OFF-BOX on the controller (the Mac) and shipped to Luke as a tarball,
# never built on Luke itself:
#   - building on the deployment host is an anti-pattern; the toolchain has no
#     business on a production box
#   - Luke's root filesystem is read-only
# The Mac is x86_64 and Luke's Turion II is amd64, so this is a native build
# with no cross-compilation. Same approach as volatile-fs in home-servers.
#
# Luke has NO AVX. Nothing here is native code - print history uses node:sqlite
# rather than better-sqlite3 for exactly that reason - so there is no
# x86-64-v2+ instruction risk. See CTHU-9 / CTHU-10.

FROM node:25-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Node 25 unbundled corepack, so it is NOT present in the image and
# `corepack enable` fails with "corepack: not found". Installing it explicitly
# keeps pnpm's version driven by "packageManager" in package.json rather than
# hardcoded here, where it would silently drift.
# --force because corepack ships yarn/yarn.cjs shims and the node image
# already has /usr/local/bin/yarn, so a plain install dies with EEXIST.
RUN npm install -g --force corepack@latest && corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdcp/package.json packages/sdcp/
COPY packages/fake-printer/package.json packages/fake-printer/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY infra/package.json infra/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @cthulhu/sdcp build \
 && pnpm --filter @cthulhu/server build \
 && pnpm --filter @cthulhu/web build

# Produce a self-contained, PRODUCTION-ONLY tree for the server.
#
# Copying /app/node_modules wholesale shipped 516 MB, of which ~346 MB was
# build tooling with no runtime role at all: aws-cdk-lib (148 MB) for infra
# that Cthulhu does not even have, Biome (62 MB), swc (32 MB), TypeScript
# (27 MB), esbuild, rolldown. `pnpm deploy --prod` resolves the workspace
# link to @cthulhu/sdcp and keeps only real runtime dependencies.
RUN pnpm --filter @cthulhu/server deploy --prod --legacy /prod/server

# ---- runtime ----------------------------------------------------------------
FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /prod/server/node_modules ./apps/server/node_modules
COPY --from=build /prod/server/dist ./apps/server/dist
COPY --from=build /prod/server/package.json ./apps/server/
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 9120
USER node
CMD ["node", "apps/server/dist/index.js"]
