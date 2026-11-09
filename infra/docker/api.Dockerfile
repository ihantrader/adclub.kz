# syntax=docker/dockerfile:1.7
#
# The `api` image (TASK-055, ARCHITECTURE 4.82): one image for the API
# process, the worker, the operator command and the release step — only the
# command differs:
#
#   node dist/main.js                API (the default)
#   node dist/worker.js              worker
#   node dist/operator.js <command>  operator command
#   node dist/release.js migrate     migrations before a deployment
#
# Built from the repository root:
#   docker build -f infra/docker/api.Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t adclub-api .
#
# The last stage holds the compiled `dist` of the API and of the workspace
# packages it uses, their production dependencies and the SQL migrations —
# no sources, no development dependencies, no `.env`; it runs as `node`.

ARG NODE_IMAGE=node:24.11.1-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

# Dependencies by the lockfile alone, into the cache mount. A cache mount is
# not part of the layer cache (CI keeps layers in GHA, not mounts): when this
# layer is reused on a fresh runner the store is empty, so the installs below
# are `--prefer-offline` — they take from the store what is there and download
# the rest — never `--offline` (TASK-055 review).
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM fetch AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prefer-offline --frozen-lockfile --filter "@adclub/api..."
RUN pnpm --filter "@adclub/api..." run build
# The production dependencies only, in place of everything installed above.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --prefer-offline --frozen-lockfile --prod --filter "@adclub/api..."

FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="adclub-api" \
      org.opencontainers.image.description="Asia Drive Club API, worker, operator command and release step" \
      org.opencontainers.image.source="https://github.com/ihantrader/adclub.kz" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    TZ=UTC \
    ADCLUB_GIT_SHA=${GIT_SHA} \
    ADCLUB_MIGRATIONS_DIR=/repo/infra/migrations
WORKDIR /repo
COPY --from=build --chown=root:root /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build --chown=root:root /repo/node_modules ./node_modules
COPY --from=build --chown=root:root /repo/packages/contracts/package.json packages/contracts/
COPY --from=build --chown=root:root /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=root:root /repo/packages/contracts/node_modules packages/contracts/node_modules
COPY --from=build --chown=root:root /repo/packages/domain/package.json packages/domain/
COPY --from=build --chown=root:root /repo/packages/domain/dist packages/domain/dist
COPY --from=build --chown=root:root /repo/packages/i18n/package.json packages/i18n/
COPY --from=build --chown=root:root /repo/packages/i18n/dist packages/i18n/dist
COPY --from=build --chown=root:root /repo/apps/api/package.json apps/api/
COPY --from=build --chown=root:root /repo/apps/api/dist apps/api/dist
COPY --from=build --chown=root:root /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build --chown=root:root /repo/infra/migrations infra/migrations
WORKDIR /repo/apps/api
# The files are root's and read-only to the process: it writes nothing to disk.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
