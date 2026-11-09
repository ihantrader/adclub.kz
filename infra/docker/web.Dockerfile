# syntax=docker/dockerfile:1.7
#
# A web client image (TASK-055, ARCHITECTURE 4.82): the supplier cabinet or
# the admin panel, built for ONE API address and served as static files by
# Caddy on :8080 behind the front proxy.
#
#   docker build -f infra/docker/web.Dockerfile \
#     --build-arg APP=supplier-web --build-arg VITE_API_URL=https://api.staging.adclub.kz \
#     --build-arg GIT_SHA=$(git rev-parse HEAD) -t adclub-supplier-web-staging .
#
# The API address is compiled into the bundle (Vite), so an image belongs to
# one environment; the registry names say which (`…-staging`). The admin
# panel's version is the label `org.opencontainers.image.version` — the
# deployment gives it to the API as ADMIN_WEB_RELEASE_VERSION.

ARG NODE_IMAGE=node:24.11.1-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10.2-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM fetch AS build
ARG APP
ARG VITE_API_URL
RUN test "$APP" = "supplier-web" -o "$APP" = "admin-web" \
 && test -n "$VITE_API_URL" || { echo "APP (supplier-web|admin-web) and VITE_API_URL are required" >&2; exit 1; }
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prefer-offline --frozen-lockfile --filter "@adclub/${APP}..."
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter "@adclub/${APP}..." run build
ARG VERSION
# The label below must tell the version this bundle reports (`X-Client`).
RUN node infra/docker/web/csp.mjs "apps/${APP}/dist" "${VITE_API_URL}" "${APP}" /security.caddy \
 && node -p "require('./apps/${APP}/package.json').version" > /version \
 && test "$(cat /version)" = "${VERSION}" \
    || { echo "VERSION must be the version of apps/${APP}/package.json ($(cat /version))" >&2; exit 1; }

FROM ${CADDY_IMAGE} AS runtime
ARG APP
ARG GIT_SHA=unknown
ARG VERSION
LABEL org.opencontainers.image.title="adclub-${APP}" \
      org.opencontainers.image.source="https://github.com/ihantrader/adclub.kz" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${VERSION}"
COPY infra/docker/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /security.caddy /etc/caddy/security.caddy
COPY --from=build /version /srv/version
COPY --from=build /repo/apps/${APP}/dist /srv/site
# Caddy keeps nothing on disk here (no certificates, no admin API).
ENV XDG_CONFIG_HOME=/tmp XDG_DATA_HOME=/tmp
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
