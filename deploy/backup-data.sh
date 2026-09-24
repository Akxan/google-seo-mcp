#!/bin/bash
# Daily backup of the server's SQLite databases (hosted.db: signed-in users' encrypted Google
# refresh tokens; oauth.db: grants issued to clients such as ChatGPT). Kept for 14 days.
#
#   deploy/backup-data.sh <data-dir> [backup-dir]
#   cron: 45 3 * * * /path/to/google-seo-mcp/deploy/backup-data.sh /path/to/google-seo-mcp/data >> /var/log/google-seo-mcp-backup.log 2>&1
#
# Do not back these up with cp. Both databases run in WAL mode, so recent writes sit in the
# -wal file until a checkpoint folds them in: a copied .db can be a near-empty file while the
# data lives next to it. sqlite3's own .backup reads through the WAL and yields one consistent file.
set -euo pipefail

DATA_DIR=${1:?usage: backup-data.sh <data-dir> [backup-dir]}
OUT_DIR=${2:-/var/backups/google-seo-mcp}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%Y%m%dT%H%M%S)
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; } # GNU and BSD date both accept this; -Is is GNU-only

command -v sqlite3 >/dev/null || { echo "[$(ts)] backup FAILED: sqlite3 is not installed" >&2; exit 1; }
# A mistyped path must fail loudly: "skipped" every night looks like a working backup that never ran.
[ -d "$DATA_DIR" ] || { echo "[$(ts)] backup FAILED: $DATA_DIR does not exist" >&2; exit 1; }
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" # other people's credentials: readable by root only

done_list=()
for db in hosted.db oauth.db; do
  [ -f "$DATA_DIR/$db" ] || continue
  out="$OUT_DIR/${db%.db}-$STAMP.db"
  sqlite3 "$DATA_DIR/$db" ".backup '$out'"
  # A backup that does not open is not a backup: prove it before keeping it.
  if [ "$(sqlite3 "$out" 'PRAGMA integrity_check;')" != "ok" ]; then
    echo "[$(ts)] backup FAILED: $db copy did not pass integrity_check" >&2
    rm -f "$out"
    exit 1
  fi
  gzip -f "$out"
  done_list+=("${db%.db}-$STAMP.db.gz ($(du -h "$out.gz" | cut -f1))")
done

find "$OUT_DIR" -name '*.db.gz' -mtime +"$KEEP_DAYS" -delete

if [ ${#done_list[@]} -eq 0 ]; then
  echo "[$(ts)] backup skipped: no databases in $DATA_DIR"
else
  echo "[$(ts)] backup ok: ${done_list[*]}"
fi
