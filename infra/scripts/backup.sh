#!/usr/bin/env bash
# The daily backup of a deployed environment (TASK-055; ARCHITECTURE 4.82,
# 15.4) — the systemd timer adclub-backup (bootstrap-vm.sh) runs it, and so
# can a person, any time:
#
#   infra/scripts/backup.sh          dump of PostgreSQL, then the files bucket
#   infra/scripts/backup.sh db       only the dump
#   infra/scripts/backup.sh files    only the files bucket
#
# The work is done by the `ops` container (its environment has the addresses
# and keys); each part is recorded in ops_run and seen in the metrics.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
what="${1:-all}"
status=0
if [[ "$what" == all || "$what" == db ]]; then
  bash "${here}/compose.sh" exec -T ops /ops/db-backup.sh || status=1
fi
if [[ "$what" == all || "$what" == files ]]; then
  bash "${here}/compose.sh" exec -T ops /ops/files-backup.sh || status=1
fi
exit "$status"
