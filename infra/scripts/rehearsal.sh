#!/usr/bin/env bash
# The staging stack rehearsed on a developer's machine (TASK-055; ARCHITECTURE
# 4.82): the same images, compose file and deploy.sh as the VM, with
# compose.staging.local.yml (proxy ports, MinIO) and rehearsal.env
# (https://localhost:8443 API, :8444 cabinet, :8445 admin panel).
#
#   infra/scripts/rehearsal.sh build [tag]    build api, ops and both web images as <name>:<tag> (default: local)
#   infra/scripts/rehearsal.sh deploy [tag]   deploy.sh with those images (secrets made on first run)
#   infra/scripts/rehearsal.sh compose <args> docker compose against the running rehearsal
#   infra/scripts/rehearsal.sh backup | restore-check
#   infra/scripts/rehearsal.sh down [-v]      stop it (-v also deletes its data)
#
# Everything of the rehearsal is in .dev-staging/ (git-ignored): its age key,
# its encrypted secrets, its "releases". The proxy's certificate is Caddy's
# own local CA: `curl -k`, and a browser warns once.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
state="${repo}/.dev-staging"
command="${1:-}"
tag="${2:-local}"

export ADCLUB_HOME="${state}/home"
export ADCLUB_RELEASE_DIR="$repo"
export ADCLUB_ENV_NAME=rehearsal
export ADCLUB_SECRETS_SOPS="${state}/rehearsal.env.sops"
export ADCLUB_SECRETS_DIR="${state}/run"
export ADCLUB_COMPOSE_OVERRIDE="${repo}/infra/docker/compose.staging.local.yml"
export ADCLUB_PULL=0
export ADCLUB_CURL_INSECURE=1
# Git Bash on Windows rewrites arguments that look like paths: the scripts'
# paths inside the ops container must reach `docker exec` as they are.
export MSYS2_ARG_CONV_EXCL="/ops/"
api_url="https://localhost:8443"

# A relative path: Node on Windows does not read Git Bash's /c/… paths.
version() { (cd "$repo" && node -p "require('./apps/$1/package.json').version"); }

case "$command" in
  build)
    sha="$(git -C "$repo" rev-parse HEAD)"
    docker build -f "${repo}/infra/docker/api.Dockerfile" --build-arg GIT_SHA="$sha" \
      --build-arg VERSION="$(version api)" -t "adclub-api:${tag}" "$repo"
    docker build -f "${repo}/infra/docker/ops.Dockerfile" --build-arg GIT_SHA="$sha" \
      -t "adclub-ops:${tag}" "$repo"
    for app in supplier-web admin-web; do
      docker build -f "${repo}/infra/docker/web.Dockerfile" --build-arg APP="$app" \
        --build-arg VITE_API_URL="$api_url" --build-arg VERSION="$(version "$app")" \
        --build-arg GIT_SHA="$sha" -t "adclub-${app}:${tag}" "$repo"
    done
    ;;
  deploy)
    [[ -f "${state}/rehearsal.env.sops" ]] ||
      node "${repo}/infra/scripts/secrets-init.mjs" rehearsal --ops-image "adclub-ops:${tag}"
    SOPS_AGE_KEY="$(cat "${state}/age.key")"
    export SOPS_AGE_KEY
    export API_IMAGE="adclub-api:${tag}" OPS_IMAGE="adclub-ops:${tag}"
    export SUPPLIER_WEB_IMAGE="adclub-supplier-web:${tag}" ADMIN_WEB_IMAGE="adclub-admin-web:${tag}"
    # A "commit" per tag, so a rollback has somewhere to go back to.
    sha="$(printf '%s' "$(git -C "$repo" rev-parse HEAD)${tag}" | sha1sum | cut -c1-40)"
    exec bash "${repo}/infra/scripts/deploy.sh" --sha "$sha"
    ;;
  rollback)
    SOPS_AGE_KEY="$(cat "${state}/age.key")"
    export SOPS_AGE_KEY
    # The release deploy.sh --rollback goes to (see there), and its images as it recorded them.
    target="$(cat "${ADCLUB_HOME}/previous" 2>/dev/null || true)"
    attempted="$(cat "${ADCLUB_HOME}/attempted" 2>/dev/null || true)"
    current="$(cat "${ADCLUB_HOME}/current" 2>/dev/null || true)"
    [[ -n "$attempted" && "$attempted" != "$current" ]] && target="$current"
    set -a
    # shellcheck disable=SC1090
    source <(grep -E '^(API|OPS|SUPPLIER_WEB|ADMIN_WEB)_IMAGE=' "${ADCLUB_HOME}/releases/${target}/release.env")
    set +a
    exec bash "${repo}/infra/scripts/deploy.sh" --rollback
    ;;
  compose)
    shift
    exec bash "${repo}/infra/scripts/compose.sh" "$@"
    ;;
  backup)
    exec bash "${repo}/infra/scripts/backup.sh"
    ;;
  restore-check)
    exec bash "${repo}/infra/scripts/restore-check.sh"
    ;;
  down)
    shift
    # By the project's name: works even when no release was recorded.
    docker compose -p adclub-rehearsal down "$@"
    ;;
  *)
    echo "usage: rehearsal.sh build [tag] | deploy [tag] | rollback | compose <args> | backup | restore-check | down [-v]" >&2
    exit 2
    ;;
esac
