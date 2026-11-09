#!/usr/bin/env bash
# The weekly restore check (TASK-055; ARCHITECTURE 4.82, 15.4) — the systemd
# timer adclub-restore-check (bootstrap-vm.sh) runs it, and so can a person:
#
#   infra/scripts/restore-check.sh
#
#   1. a temporary PostgreSQL container (the stack's own image) in the stack's
#      network, with a password made up for this run only;
#   2. the `ops` container restores the latest dump of the backups bucket into
#      it and compares the row counts of the key tables with the counts taken
#      in the dump's own snapshot;
#   3. the `api` image of the running release checks every migration is
#      applied in the restored base (`release.js status`);
#   4. the result goes to the log and to ops_run (metric
#      adclub_ops_last_run_ok{kind="restore_check"}); the container is removed.
#
# Exit 1 when anything fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ADCLUB_HOME="${ADCLUB_HOME:-/opt/adclub}"
current="$(cat "${ADCLUB_HOME}/current")"
release_env="${ADCLUB_HOME}/releases/${current}/release.env"
api_image="$(grep -E '^API_IMAGE=' "$release_env" | cut -d= -f2-)"
release_dir="$(grep -E '^ADCLUB_RELEASE_DIR=' "$release_env" | cut -d= -f2-)"
env_name="$(grep -E '^ADCLUB_ENV_NAME=' "$release_env" | cut -d= -f2-)"
# The stack's network is named after the project (compose.staging.yml).
network="$(grep -E '^COMPOSE_PROJECT_NAME=' "${release_dir}/infra/docker/${env_name}.env" | cut -d= -f2-)"
postgres_image="$(bash "${here}/compose.sh" config --images | grep -E '^postgres:' | head -n 1)"
[[ -n "$network" && -n "$postgres_image" ]] || {
  echo "restore-check: cannot read the stack's network and PostgreSQL image" >&2
  exit 1
}

name="adclub-restore-check-$$"
password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
log() { printf '%s restore-check: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "temporary ${postgres_image} '${name}' in ${network}"
# Passwords go to the containers by name (-e NAME), never as values on a command line.
export POSTGRES_PASSWORD="$password" RESTORE_PGPASSWORD="$password"
export DATABASE_URL="postgres://postgres:${password}@${name}:5432/adclub_restore"
docker run -d --rm --name "$name" --network "$network" \
  -e POSTGRES_PASSWORD --shm-size 256m "$postgres_image" >/dev/null

restored=0
bash "${here}/compose.sh" exec -T -e RESTORE_PGPASSWORD ops \
  /ops/restore-check.sh restore "$name" && restored=1

migrations=false
if [[ "$restored" == 1 ]]; then
  log "migration status of the restored base (${api_image})"
  if docker run --rm --network "$network" -e DATABASE_URL \
    "$api_image" node dist/release.js status; then
    migrations=true
  fi
fi

if bash "${here}/compose.sh" exec -T ops /ops/restore-check.sh record "$migrations"; then
  log "OK"
else
  log "FAILED"
  exit 1
fi
