#!/usr/bin/env bash
# The restore check (TASK-055; ARCHITECTURE 4.82, 15.4), in two steps run by
# infra/scripts/restore-check.sh on the host:
#
#   restore-check.sh restore <host>       restore the latest dump into the
#       temporary PostgreSQL at <host> (password RESTORE_PGPASSWORD, database
#       adclub_restore) and compare the row counts of the key tables with the
#       counts taken in the dump's own snapshot
#   restore-check.sh record <true|false>  record the result in ops_run (kind
#       restore_check); the argument says whether the API image's
#       `release.js status` found every migration applied in the restored base
#
# Exit 1 when the restore fails or a count differs.
source /ops/lib.sh

state="/tmp/restore-check"
command="${1:-}"

case "$command" in
  restore)
    host="${2:?usage: restore-check.sh restore <host>}"
    : "${RESTORE_PGPASSWORD:?RESTORE_PGPASSWORD is not set}"
    rm -rf "$state" && mkdir -p "$state"
    date -u +%Y-%m-%dT%H:%M:%SZ >"${state}/started"
    # The temporary base's password goes by PGPASSWORD, not in the address.
    export PGPASSWORD="$RESTORE_PGPASSWORD"
    restored="postgres://postgres@${host}:5432"

    # The newest complete dump: one with its counts (a `.dump` gets its name
    # only after a successful run; `.dump.partial` never counts).
    listing="$(rclone lsf -R --files-only "${BACKUPS}/db")"
    latest="$(grep -E '\.dump$' <<<"$listing" | sort -r | while read -r dump; do
      grep -qxF "${dump%.dump}.counts.json" <<<"$listing" && { echo "$dump"; break; }
    done)"
    if [[ -z "$latest" ]]; then
      log "restore-check: no dump in ${BACKUP_PREFIX}/db"
      jq -nc '{stage: "no dump", ok: false}' >"${state}/result.json"
      exit 1
    fi
    counts="${latest%.dump}.counts.json"
    log "restore-check: restoring ${BACKUP_PREFIX}/db/${latest}"
    rclone copyto "${BACKUPS}/db/${latest}" "${state}/backup.dump"
    rclone copyto "${BACKUPS}/db/${counts}" "${state}/expected.json"

    tries=0
    until pg_isready -q -d "${restored}/postgres"; do
      tries=$((tries + 1))
      if ((tries > 120)); then
        jq -nc --arg object "$latest" '{object: $object, stage: "temporary postgres not ready", ok: false}' \
          >"${state}/result.json"
        log "restore-check: the temporary PostgreSQL did not start in 2 minutes"
        exit 1
      fi
      sleep 1
    done
    psql "${restored}/postgres" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE adclub_restore" >/dev/null
    if ! pg_restore --no-owner --no-privileges --exit-on-error \
      --dbname="${restored}/adclub_restore" "${state}/backup.dump"; then
      jq -nc --arg object "$latest" '{object: $object, stage: "pg_restore", ok: false}' >"${state}/result.json"
      log "restore-check: pg_restore FAILED"
      exit 1
    fi

    psql "${restored}/adclub_restore" -X -q -A -t -v ON_ERROR_STOP=1 -c "$(counts_query)" \
      >"${state}/actual.json"
    jq -n --arg object "$latest" \
      --slurpfile expected "${state}/expected.json" --slurpfile actual "${state}/actual.json" '
        ($expected[0]) as $e | ($actual[0]) as $a
        | [$e | keys[] | select($e[.] != $a[.]) | {table: ., expected: $e[.], restored: $a[.]}] as $diff
        | {object: $object, tables: ($e | length), counts: $a, mismatches: $diff, ok: ($diff | length == 0)}
      ' >"${state}/result.json"
    jq -r '"restore-check: \(.tables) tables compared, \(.mismatches | length) mismatches"' "${state}/result.json" |
      while read -r line; do log "$line"; done
    jq -e '.mismatches | length == 0' "${state}/result.json" >/dev/null || {
      log "restore-check: mismatches $(jq -c .mismatches "${state}/result.json")"
      exit 1
    }
    log "restore-check: row counts match the dump's snapshot"
    ;;
  record)
    migrations="${2:?usage: restore-check.sh record <true|false>}"
    started="$(cat "${state}/started" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
    result="$(cat "${state}/result.json" 2>/dev/null || echo '{"stage":"not run","ok":false}')"
    details="$(jq -c --argjson migrations "$migrations" \
      '{object, tables, mismatches, stage, migrationsApplied: $migrations} | with_entries(select(.value != null))' <<<"$result")"
    ok="$(jq -r --argjson migrations "$migrations" '(.ok == true) and $migrations' <<<"$result")"
    ops_record restore_check "$ok" "$started" "$details"
    log "restore-check: recorded ok=${ok} ${details}"
    rm -rf "$state"
    [[ "$ok" == "true" ]]
    ;;
  *)
    echo "usage: restore-check.sh restore <host> | record <true|false>" >&2
    exit 2
    ;;
esac
