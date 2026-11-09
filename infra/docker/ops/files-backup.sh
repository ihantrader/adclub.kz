#!/usr/bin/env bash
# The daily copy of the files bucket into the backups bucket (TASK-055;
# ARCHITECTURE 4.82, 15.4) — for a provider without bucket versioning over the
# S3 API; with versioning on, it is a second line of defence.
#
#   <prefix>/files/current/...            the bucket as of this run
#   <prefix>/files/removed/YYYY-MM-DD/... what the run of that day removed or replaced
#
# What was removed or replaced is kept BACKUP_RETENTION_DAYS from the day it
# was removed: the folders of `removed/` expire by the date in their names.
# Not by the age of the objects — a moved object keeps the modification time
# of the original, so a photo uploaded a month ago and deleted today would
# expire in the very run that saved it. Recorded in ops_run (kind
# files_backup). Exit 1 on failure.
source /ops/lib.sh

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
day="$(date -u +%Y-%m-%d)"

fail() {
  log "files-backup: FAILED at ${1}"
  ops_record files_backup false "$started" "$(jq -nc --arg stage "$1" '{stage: $stage}')" || true
  exit 1
}

log "files-backup: copying the files bucket into ${BACKUP_PREFIX}/files/current"
rclone sync "files:${S3_BUCKET}" "${BACKUPS}/files/current" \
  --backup-dir "${BACKUPS}/files/removed/${day}" --checksum || fail "sync"

# The days whose folder is older than the retention (names compare as dates).
cutoff="$(date -u -d "@$(($(date -u +%s) - BACKUP_RETENTION_DAYS * 86400))" +%Y-%m-%d)"
expired=0
while IFS= read -r folder; do
  folder="${folder%/}"
  [[ "$folder" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$folder" < "$cutoff" ]] || continue
  rclone purge "${BACKUPS}/files/removed/${folder}" || fail "retention"
  expired=$((expired + 1))
done < <(rclone lsf --dirs-only "${BACKUPS}/files/removed" 2>/dev/null || true)

size="$(rclone size --json "${BACKUPS}/files/current")"
log "files-backup: $(jq -c . <<<"$size"); removed days expired: ${expired}"
ops_record files_backup true "$started" \
  "$(jq -c --argjson expired "$expired" '{objects: .count, bytes: .bytes, expiredDays: $expired}' <<<"$size")"
log "files-backup: done"
