# syntax=docker/dockerfile:1

# Luke is an old HP ProLiant N40L with NO AVX. Some prebuilt Node binaries and
# container images assume x86-64-v2 or later; Plane needed compatibility tweaks
# on this same host for exactly that reason. Anything native (better-sqlite3,
# sharp) must be checked on the target, not just in CI. See CTHU-9 / CTHU-10.
FROM node:25-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdcp/package.json packages/sdcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @cthulhu/sdcp build \
 && pnpm --filter @cthulhu/server build \
 && pnpm --filter @cthulhu/web build

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sdcp/dist ./packages/sdcp/dist
COPY --from=build /app/packages/sdcp/package.json ./packages/sdcp/
COPY --from=build /app/packages/sdcp/node_modules ./packages/sdcp/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 9120
USER node
CMD ["node", "apps/server/dist/index.js"]
