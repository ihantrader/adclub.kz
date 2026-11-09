# syntax=docker/dockerfile:1.7
#
# The `ops` image (TASK-055, ARCHITECTURE 4.82, 15.4): the tools of a
# deployed environment — the daily dump of PostgreSQL and copy of the files
# bucket into the backups bucket, the weekly restore check, and sops + age to
# decrypt the environment's secrets at deployment.
#
#   docker build -f infra/docker/ops.Dockerfile -t adclub-ops .
#
# In the stack it idles as the service `ops` (the environment's addresses
# and keys in its environment); the host's timers run its scripts with
# `docker compose exec ops /ops/<script>` (infra/scripts/backup.sh,
# restore-check.sh). Packages come from the pinned Alpine release's stable
# branch (only security fixes move there).

FROM alpine:3.22.2
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="adclub-ops" \
      org.opencontainers.image.source="https://github.com/ihantrader/adclub.kz" \
      org.opencontainers.image.revision="${GIT_SHA}"
RUN apk add --no-cache bash ca-certificates tzdata postgresql16-client rclone sops age jq \
 && adduser -D -u 10001 ops
COPY --chmod=0755 infra/docker/ops/ /ops/
ENV TZ=UTC
USER ops
WORKDIR /tmp
# Idles until stopped; the work is done by `docker compose exec`.
CMD ["/ops/idle.sh"]
