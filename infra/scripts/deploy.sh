#!/usr/bin/env bash
# Deploys a release of the staging stack (TASK-055; ARCHITECTURE 4.82, 15.5).
# Runs on the VM as `deploy` (from CI: .github/workflows/deploy-staging.yml),
# and on a developer's machine for the rehearsal (infra/scripts/rehearsal.sh).
#
#   deploy.sh --sha <commit>        deploy the release of that commit
#   deploy.sh --rollback            deploy the release before the current one again
#
# Options:
#   --secrets-from-stdin   read the age key of sops (line 1) and, optionally, a
#                          token for ghcr.io (line 2) from stdin — CI passes
#                          them this way, never on a command line
#
# What it does, in this order — a failure stops it with the running
# containers untouched until step 6:
#   1. the images of the release: <registry>/adclub-{api,ops}:sha-<short>,
#      adclub-{supplier,admin}-web-staging:sha-<short> (pulled);
#   2. the admin panel version from its image's label → ADMIN_WEB_RELEASE_VERSION;
#   3. the secrets: staging.env.sops decrypted (sops + age, in the ops image)
#      into a file only `deploy` can read, on tmpfs, removed on exit;
#   4. PostgreSQL, Redis and Meilisearch up and healthy;
#   5. the migrations in a one-off container of the NEW api image
#      (`release.js migrate`: pg-boss schema check, `up`, nothing pending) —
#      a failed migration ends the deployment here: api and worker still run
#      the previous release;
#   6. api, worker, web clients, proxy and ops replaced (`up -d --wait`);
#   7. through the proxy: /ready 200, /health 200, /meta/client-policy with the
#      admin panel's X-Client, the cabinet and the admin panel answer;
#   8. the release is recorded as current (the previous one kept for --rollback).
#
# Environment (defaults are the VM's):
#   ADCLUB_HOME          /opt/adclub — releases/<sha>/ (infra/ of the commit, release.env), current, previous
#   ADCLUB_REGISTRY      ghcr.io/ihantrader
#   ADCLUB_ENV_NAME      staging — infra/docker/<name>.env, infra/secrets/<name>.env.sops
#   ADCLUB_RELEASE_DIR   where infra/ of this release is (default: $ADCLUB_HOME/releases/<sha>)
#   ADCLUB_COMPOSE_OVERRIDE  an extra compose file (the rehearsal's compose.staging.local.yml)
#   ADCLUB_PULL          1 — pull the images; 0 — they are local (rehearsal)
#   ADCLUB_CURL_INSECURE 0 — 1 accepts the rehearsal's local certificate
#   API_IMAGE OPS_IMAGE SUPPLIER_WEB_IMAGE ADMIN_WEB_IMAGE — instead of the registry names
#   SOPS_AGE_KEY         the age key, when not given on stdin
set -euo pipefail

ADCLUB_HOME="${ADCLUB_HOME:-/opt/adclub}"
ADCLUB_REGISTRY="${ADCLUB_REGISTRY:-ghcr.io/ihantrader}"
ADCLUB_ENV_NAME="${ADCLUB_ENV_NAME:-staging}"
ADCLUB_PULL="${ADCLUB_PULL:-1}"
ADCLUB_CURL_INSECURE="${ADCLUB_CURL_INSECURE:-0}"

log() { printf '%s deploy: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "FAILED — $*"
  exit 1
}

sha=""
rollback=0
secrets_from_stdin=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      sha="${2:?--sha needs a commit}"
      shift 2
      ;;
    --rollback)
      rollback=1
      shift
      ;;
    --secrets-from-stdin)
      secrets_from_stdin=1
      shift
      ;;
    *) die "unknown option $1" ;;
  esac
done

mkdir -p "$ADCLUB_HOME"
# One deployment at a time: CI's `concurrency` covers CI runs only; deploy.sh
# or --rollback started by hand on the VM meanwhile would interleave the
# steps and record a release other than the one running.
if command -v flock >/dev/null 2>&1; then
  exec 9>"${ADCLUB_HOME}/deploy.lock"
  flock -n 9 || die "another deployment is running (${ADCLUB_HOME}/deploy.lock)"
fi

if [[ "$rollback" == 1 ]]; then
  # After a deployment that failed once its containers were replaced (step 6
  # or 7), the stack runs the attempt, not `current`: going back means `current`
  # — also when the attempt was `current` itself (a re-deploy to recreate the
  # containers): they may be half replaced, deploying `current` again puts
  # them right. Otherwise — the release before `current`.
  attempted="$(cat "${ADCLUB_HOME}/attempted" 2>/dev/null || true)"
  current="$(cat "${ADCLUB_HOME}/current" 2>/dev/null || true)"
  if [[ -n "$attempted" && -n "$current" ]]; then
    sha="$current"
  else
    [[ -f "${ADCLUB_HOME}/previous" ]] || die "no previous release to roll back to"
    sha="$(cat "${ADCLUB_HOME}/previous")"
  fi
  log "rolling back to ${sha}"
fi
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "--sha <commit> (hex) or --rollback is required"
short="${sha:0:7}"
release="${ADCLUB_HOME}/releases/${sha}"
release_dir="${ADCLUB_RELEASE_DIR:-$release}"
mkdir -p "$release"
[[ -f "${release_dir}/infra/docker/compose.staging.yml" ]] || die "no infra/ of ${sha} in ${release_dir}"

if [[ "$secrets_from_stdin" == 1 ]]; then
  IFS= read -r SOPS_AGE_KEY || true
  IFS= read -r ghcr_token || true
  export SOPS_AGE_KEY
fi

curl_flags=(--silent --show-error --max-time 10)
[[ "$ADCLUB_CURL_INSECURE" == 1 ]] && curl_flags+=(--insecure)

# --- 1. images ---------------------------------------------------------------
API_IMAGE="${API_IMAGE:-${ADCLUB_REGISTRY}/adclub-api:sha-${short}}"
OPS_IMAGE="${OPS_IMAGE:-${ADCLUB_REGISTRY}/adclub-ops:sha-${short}}"
SUPPLIER_WEB_IMAGE="${SUPPLIER_WEB_IMAGE:-${ADCLUB_REGISTRY}/adclub-supplier-web-${ADCLUB_ENV_NAME}:sha-${short}}"
ADMIN_WEB_IMAGE="${ADMIN_WEB_IMAGE:-${ADCLUB_REGISTRY}/adclub-admin-web-${ADCLUB_ENV_NAME}:sha-${short}}"
images=("$API_IMAGE" "$OPS_IMAGE" "$SUPPLIER_WEB_IMAGE" "$ADMIN_WEB_IMAGE")
if [[ "$ADCLUB_PULL" == 1 ]]; then
  if [[ -n "${ghcr_token:-}" ]]; then
    printf '%s' "$ghcr_token" | docker login ghcr.io -u "${ADCLUB_REGISTRY_USER:-deploy}" --password-stdin >/dev/null
  fi
  for image in "${images[@]}"; do
    log "pull ${image}"
    if ! docker pull --quiet "$image" >/dev/null; then
      # A rollback by hand has no registry token; its images are still here.
      docker image inspect "$image" >/dev/null 2>&1 || die "cannot pull ${image}"
      log "cannot pull ${image}: the local copy is used"
    fi
  done
fi
for image in "${images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "image ${image} is not here"
done

# --- 2. the admin panel version ---------------------------------------------
admin_version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$ADMIN_WEB_IMAGE")"
[[ "$admin_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the admin-web image has no version label"
log "admin panel ${admin_version}"

# --- 3. secrets ---------------------------------------------------------------
secrets_dir="${ADCLUB_SECRETS_DIR:-/run/adclub}"
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir" 2>/dev/null || true
secrets_file="$(mktemp "${secrets_dir}/${ADCLUB_ENV_NAME}.env.XXXXXX")"
chmod 600 "$secrets_file"
cleanup() { rm -f "$secrets_file" "${secrets_file}".*; }
trap cleanup EXIT
sops_file="${ADCLUB_SECRETS_SOPS:-${release_dir}/infra/secrets/${ADCLUB_ENV_NAME}.env.sops}"
[[ -f "$sops_file" ]] || die "no ${sops_file}"
[[ -n "${SOPS_AGE_KEY:-}" ]] || die "SOPS_AGE_KEY is not set"
# The key goes to the container by name (-e SOPS_AGE_KEY), never as a value
# on a command line; the decrypted text goes only into the file.
docker run --rm -i -e SOPS_AGE_KEY --entrypoint sops "$OPS_IMAGE" \
  --decrypt --input-type dotenv --output-type dotenv /dev/stdin <"$sops_file" >"$secrets_file" ||
  die "cannot decrypt ${sops_file##*/} (is the age key one of .sops.yaml?)"
log "secrets decrypted ($(grep -c '=' "$secrets_file") variables)"
# Each data service gets only its own secret; the full file goes to api,
# worker and the release step only (compose.staging.yml, x-secrets-*).
scoped() { # <suffix> <variable names, a regex alternation>
  (
    umask 077
    grep -E "^($2)=" "$secrets_file" >"${secrets_file}.$1" || true
  )
}
scoped postgres 'POSTGRES_PASSWORD'
scoped redis 'REDIS_PASSWORD'
scoped meilisearch 'MEILI_MASTER_KEY'
scoped ops 'DATABASE_URL|S3_ACCESS_KEY|S3_SECRET_KEY|BACKUP_S3_ACCESS_KEY|BACKUP_S3_SECRET_KEY'
scoped minio 'S3_ACCESS_KEY|S3_SECRET_KEY'

# --- the release's compose -------------------------------------------------------
{
  echo "ADCLUB_RELEASE=${sha}"
  echo "API_IMAGE=${API_IMAGE}"
  echo "OPS_IMAGE=${OPS_IMAGE}"
  echo "SUPPLIER_WEB_IMAGE=${SUPPLIER_WEB_IMAGE}"
  echo "ADMIN_WEB_IMAGE=${ADMIN_WEB_IMAGE}"
  echo "ADMIN_WEB_RELEASE_VERSION=${admin_version}"
  echo "ADCLUB_RELEASE_DIR=${release_dir}"
  echo "ADCLUB_ENV_NAME=${ADCLUB_ENV_NAME}"
  [[ -n "${ADCLUB_COMPOSE_OVERRIDE:-}" ]] && echo "ADCLUB_COMPOSE_OVERRIDE=${ADCLUB_COMPOSE_OVERRIDE}"
} >"${release}/release.env.next"

compose() {
  local files=(-f "${release_dir}/infra/docker/compose.staging.yml")
  [[ -n "${ADCLUB_COMPOSE_OVERRIDE:-}" ]] && files+=(-f "$ADCLUB_COMPOSE_OVERRIDE")
  ADCLUB_ENV_FILE="$secrets_file" docker compose "${files[@]}" \
    --env-file "${release_dir}/infra/docker/${ADCLUB_ENV_NAME}.env" \
    --env-file "${release}/release.env.next" "$@"
}
compose config --quiet || die "compose configuration is invalid"
# shellcheck disable=SC1090
source <(grep -E '^(API|CABINET|ADMIN)_PUBLIC_URL=' "${release_dir}/infra/docker/${ADCLUB_ENV_NAME}.env")

# --- 4. data services ---------------------------------------------------------
log "data services"
compose up -d --wait postgres redis meilisearch || die "data services are not healthy"

# --- 5. migrations before the code ----------------------------------------------
log "migrations (one-off container of ${API_IMAGE})"
if ! compose --profile release run --rm --no-deps migrate; then
  log "the migration failed: api and worker keep running the previous release"
  rm -f "${release}/release.env.next"
  die "migrations"
fi

# --- 6. the new release -------------------------------------------------------------
log "replacing api, worker, web clients, proxy, ops"
# From here a failure leaves the attempt running: --rollback then returns to `current`.
echo "$sha" >"${ADCLUB_HOME}/attempted"
compose up -d --wait --remove-orphans api worker supplier-web admin-web proxy ops ||
  die "the new containers are not healthy — roll back: deploy.sh --rollback"

# --- 7. through the proxy ---------------------------------------------------------
check() {
  local name="$1" url="$2" header="${3:-}" code
  local args=("${curl_flags[@]}" --output /dev/null --write-out '%{http_code}')
  [[ -n "$header" ]] && args+=(--header "$header")
  for _ in $(seq 1 60); do
    code="$(curl "${args[@]}" "$url" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then
      log "${name}: 200"
      return 0
    fi
    sleep 2
  done
  die "${name}: ${code:-no answer} — roll back: deploy.sh --rollback"
}
check "/ready" "${API_PUBLIC_URL}/ready"
check "/health" "${API_PUBLIC_URL}/health"
check "/meta/client-policy (admin-web/${admin_version})" "${API_PUBLIC_URL}/meta/client-policy" \
  "X-Client: admin-web/${admin_version}"
check "cabinet" "${CABINET_PUBLIC_URL}/"
check "admin panel" "${ADMIN_PUBLIC_URL}/"

# --- 8. record ---------------------------------------------------------------------
mv "${release}/release.env.next" "${release}/release.env"
current="$(cat "${ADCLUB_HOME}/current" 2>/dev/null || true)"
if [[ -n "$current" && "$current" != "$sha" ]]; then
  echo "$current" >"${ADCLUB_HOME}/previous"
fi
echo "$sha" >"${ADCLUB_HOME}/current"
rm -f "${ADCLUB_HOME}/attempted"
log "release ${short} is live (admin panel ${admin_version}); previous: $(cat "${ADCLUB_HOME}/previous" 2>/dev/null || echo none)"
