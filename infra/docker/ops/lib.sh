#!/usr/bin/env bash
# Shared by the scripts of the `ops` image (TASK-055, ARCHITECTURE 4.82).
#
# The environment of the `ops` service (compose.staging.yml):
#   DATABASE_URL                      the environment's PostgreSQL
#   S3_ENDPOINT S3_REGION S3_BUCKET   the files bucket (what the API stores)
#   S3_ACCESS_KEY S3_SECRET_KEY
#   BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
#                                     the backups bucket (default: the files bucket's)
#   BACKUP_S3_BUCKET                  the bucket of backups
#   BACKUP_PREFIX                     a folder in it (default: staging)
#   BACKUP_RETENTION_DAYS             how long dumps and removed files are kept (default: 14)
#
# Nothing here prints an address with a password, a key or a row of data.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${S3_BUCKET:?S3_BUCKET is not set}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is not set}"
BACKUP_PREFIX="${BACKUP_PREFIX:-staging}"

# Passwords never on a command line (anybody on the VM reads `ps`): libpq gets
# the address without its password (DB_URL) and the password in PGPASSWORD.
if [[ "$DATABASE_URL" =~ ^(postgres(ql)?://[^:/@]+):([^@]*)@(.*)$ ]]; then
  PGPASSWORD="$(printf '%b' "${BASH_REMATCH[3]//%/\\x}")"
  export PGPASSWORD
  DB_URL="${BASH_REMATCH[1]}@${BASH_REMATCH[4]}"
else
  DB_URL="$DATABASE_URL"
fi
export DB_URL
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# rclone remotes from the environment, without a config file: `files:` and `backups:`.
export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_FILES_TYPE=s3
export RCLONE_CONFIG_FILES_PROVIDER=Other
export RCLONE_CONFIG_FILES_ENDPOINT="${S3_ENDPOINT:?S3_ENDPOINT is not set}"
export RCLONE_CONFIG_FILES_REGION="${S3_REGION:-us-east-1}"
export RCLONE_CONFIG_FILES_ACCESS_KEY_ID="${S3_ACCESS_KEY:?S3_ACCESS_KEY is not set}"
export RCLONE_CONFIG_FILES_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?S3_SECRET_KEY is not set}"
export RCLONE_CONFIG_FILES_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_FILES_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_BACKUPS_TYPE=s3
export RCLONE_CONFIG_BACKUPS_PROVIDER=Other
export RCLONE_CONFIG_BACKUPS_ENDPOINT="${BACKUP_S3_ENDPOINT:-$S3_ENDPOINT}"
export RCLONE_CONFIG_BACKUPS_REGION="${BACKUP_S3_REGION:-${S3_REGION:-us-east-1}}"
export RCLONE_CONFIG_BACKUPS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-$S3_ACCESS_KEY}"
export RCLONE_CONFIG_BACKUPS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-$S3_SECRET_KEY}"
export RCLONE_CONFIG_BACKUPS_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_BACKUPS_NO_CHECK_BUCKET=true

# shellcheck disable=SC2034 # used by the scripts that source this file
BACKUPS="backups:${BACKUP_S3_BUCKET}/${BACKUP_PREFIX}"

# The tables whose row counts are recorded with every dump and compared after
# a restore (one snapshot for the dump and the counts).
KEY_TABLES=(account supplier supplier_member catalog_item offer customer_order order_event
  review subscription audit_log app_setting pgmigrations)

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# ops_record <kind> <true|false> <started-at ISO> <details JSON>
# One row of ops_run in the environment's database — the API's metrics read it.
ops_record() {
  # Variables are interpolated (and quoted) only in psql's input, not in -c.
  printf '%s\n' \
    "INSERT INTO ops_run (kind, ok, started_at, details) VALUES (:'kind', :'ok'::boolean, :'started'::timestamptz, :'details'::jsonb);" |
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
      -v kind="$1" -v ok="$2" -v started="$3" -v details="$4" >/dev/null
}

# The JSON object of the row counts of KEY_TABLES, as one SELECT.
counts_query() {
  local parts=() table
  for table in "${KEY_TABLES[@]}"; do
    parts+=("'${table}', (SELECT count(*) FROM ${table})")
  done
  local IFS=,
  printf 'SELECT json_build_object(%s)' "${parts[*]}"
}
