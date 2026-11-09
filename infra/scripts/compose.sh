#!/usr/bin/env bash
# `docker compose` against the running release of the stack (TASK-055), with
# the variables deploy.sh used — for logs, the operator command, backups:
#
#   infra/scripts/compose.sh ps
#   infra/scripts/compose.sh logs -f --since 10m api worker
#   infra/scripts/compose.sh exec api node dist/operator.js settings:list
#   infra/scripts/compose.sh exec -T ops /ops/db-backup.sh
#
# The secrets are not here (they were removed after the deployment): `up` of
# a service that needs them is deploy.sh's job, everything else works.
set -euo pipefail

ADCLUB_HOME="${ADCLUB_HOME:-/opt/adclub}"
current="$(cat "${ADCLUB_HOME}/current" 2>/dev/null)" || {
  echo "compose.sh: no current release in ${ADCLUB_HOME}" >&2
  exit 1
}
release_env="${ADCLUB_HOME}/releases/${current}/release.env"
release_dir="$(grep -E '^ADCLUB_RELEASE_DIR=' "$release_env" | cut -d= -f2-)"
env_name="$(grep -E '^ADCLUB_ENV_NAME=' "$release_env" | cut -d= -f2-)"
override="$(grep -E '^ADCLUB_COMPOSE_OVERRIDE=' "$release_env" | cut -d= -f2- || true)"

files=(-f "${release_dir}/infra/docker/compose.staging.yml")
[[ -n "$override" ]] && files+=(-f "$override")
exec docker compose "${files[@]}" \
  --env-file "${release_dir}/infra/docker/${env_name:-staging}.env" \
  --env-file "$release_env" "$@"
