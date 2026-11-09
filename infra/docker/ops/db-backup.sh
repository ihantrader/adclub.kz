#!/usr/bin/env bash
# The daily dump of PostgreSQL into the backups bucket (TASK-055; ARCHITECTURE
# 4.82, 15.4):
#
#   <prefix>/db/YYYY/MM/DD/adclub-<UTC time>.dump          pg_dump, custom format, compressed
#   <prefix>/db/YYYY/MM/DD/adclub-<UTC time>.counts.json   row counts of the key tables
#
# The dump and the counts are taken in ONE snapshot (an exported snapshot of
# a repeatable read transaction), so the restore check can compare them
# exactly. The dump is streamed to `<name>.dump.partial` and gets its final
# name only when pg_dump succeeded and the counts are uploaded: a dump that
# died half way never becomes «the latest». Dumps older than
# BACKUP_RETENTION_DAYS are deleted. The run is recorded in ops_run (kind
# db_backup). Exit 1 on failure.
source /ops/lib.sh

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
object="db/$(date -u +%Y/%m/%d)/adclub-${stamp}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export ADCLUB_DUMP_TARGET="${BACKUPS}/${object}.dump.partial"
export ADCLUB_DUMP_STATUS="${work}/dump.status"

fail() {
  log "db-backup: FAILED at ${1}"
  rclone deletefile "$ADCLUB_DUMP_TARGET" 2>/dev/null || true
  ops_record db_backup false "$started" "$(jq -nc --arg stage "$1" --arg object "$object" '{stage: $stage, object: $object}')" || true
  exit 1
}

# psql holds the transaction; pg_dump (run from inside it with \!) reads the
# very snapshot the counts were taken in. Both connect by DB_URL (no password
# in it) with PGPASSWORD from the environment (lib.sh).
{
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
  echo "SELECT pg_export_snapshot() AS adclub_snapshot \\gset"
  echo "\\setenv ADCLUB_SNAPSHOT :adclub_snapshot"
  echo "\\o ${work}/counts.json"
  echo "$(counts_query);"
  echo "\\o"
  echo "\\! bash -c 'set -o pipefail; pg_dump --format=custom --compress=6 --no-owner --no-privileges --snapshot=\"\$ADCLUB_SNAPSHOT\" --dbname=\"\$DB_URL\" | rclone rcat \"\$ADCLUB_DUMP_TARGET\"; echo \$? > \"\$ADCLUB_DUMP_STATUS\"'"
  echo "COMMIT;"
} >"${work}/backup.sql"

log "db-backup: dumping into ${BACKUP_PREFIX}/${object}.dump"
psql "$DB_URL" -X -q -A -t -v ON_ERROR_STOP=1 -f "${work}/backup.sql" >/dev/null || fail "snapshot"
[[ "$(cat "${work}/dump.status" 2>/dev/null)" == "0" ]] || fail "pg_dump"
jq -e . "${work}/counts.json" >/dev/null || fail "counts"
rclone copyto "${work}/counts.json" "${BACKUPS}/${object}.counts.json" || fail "upload counts"
rclone moveto "$ADCLUB_DUMP_TARGET" "${BACKUPS}/${object}.dump" || fail "final name"

bytes="$(rclone size --json "${BACKUPS}/${object}.dump" | jq '.bytes')"
log "db-backup: ${bytes} bytes; counts $(jq -c . "${work}/counts.json")"

# Retention: by the age of the objects, with nothing but the S3 API (a dump
# is written once and never moved, so its modification time is its day).
rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" "${BACKUPS}/db" || fail "retention"
rclone rmdirs --leave-root "${BACKUPS}/db" 2>/dev/null || true

ops_record db_backup true "$started" "$(jq -c --arg object "${object}.dump" --argjson bytes "$bytes" \
  '{object: $object, bytes: $bytes, counts: .}' "${work}/counts.json")"
log "db-backup: done"
