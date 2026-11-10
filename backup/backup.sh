#!/usr/bin/env bash
# Nightly backup of Margins to Cloudflare R2 (OPS-H1). Runs as the Railway cron service `backup` (.railway/railway.ts).
#
# 1. One snapshot of the database: the row count of every table and `pg_dump -Fc` read the same snapshot, so a
#    restore can be checked against the counts exactly (scripts/restore_drill.py).
# 2. The dump and a manifest (counts, newest migration, embedding model, sizes) go to daily/<run time>/, and on Sundays
#    also to weekly/<run time>/. R2 keeps daily copies 35 days and weekly ones 120, and a lock rule keeps every object
#    under daily/ and weekly/ for at least 7 days, so a leaked key cannot delete recent backups.
# 3. The uploads bucket is mirrored to uploads/current/. Objects deleted or replaced since the last run move to
#    uploads/deleted/<run time>/ (kept 35 days, and locked for 7 like the dumps). The mirror includes ops/deletions/,
#    the record of deleted accounts a restore replays. uploads/current/ itself cannot be locked (each run rewrites
#    it), so a leaked R2 key could empty the mirror; the database dumps and the deleted copies stay.
# 4. Success is written to ops_state.backup_last_success; the AI service's watchdog alerts when it is over
#    BACKUP_MAX_AGE_HOURS old. A failure is also recorded in ops_events, which the watchdog reports on its next run.
#
# Everything is encrypted before it leaves (rclone crypt, BACKUP_PASSPHRASE; file names stay readable). Without the
# passphrase the backups cannot be read: it is kept outside Railway too (docs/deployment/RESTORE.md).
#
# Environment: DATABASE_URL; S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (the uploads
# bucket); R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; BACKUP_PASSPHRASE.
set -Eeuo pipefail

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

for name in DATABASE_URL S3_BUCKET S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY \
  R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_PASSPHRASE; do
  if [ -z "${!name:-}" ]; then
    log "missing $name"
    exit 2
  fi
done

note_failure() {
  local status=$? line=$1
  log "failed at line $line (exit $status)"
  # SQL on stdin: psql substitutes :'detail' there, not in -c.
  echo "INSERT INTO ops_events (kind, source, detail, created_at)
        VALUES ('backup_failed', 'backup', :'detail', now() AT TIME ZONE 'UTC');" |
    psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -v detail="line $line, exit $status" >/dev/null 2>&1 ||
    log "could not record the failure in ops_events"
  exit "$status"
}
trap 'note_failure $LINENO' ERR

# rclone remotes, from the environment only (no config file).
export RCLONE_CONFIG_UPLOADS_TYPE=s3
export RCLONE_CONFIG_UPLOADS_PROVIDER=Other
export RCLONE_CONFIG_UPLOADS_ENDPOINT="$S3_ENDPOINT"
export RCLONE_CONFIG_UPLOADS_REGION="${S3_REGION:-auto}"
export RCLONE_CONFIG_UPLOADS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_UPLOADS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_UPLOADS_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-false}"
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_SAFE_TYPE=crypt
export RCLONE_CONFIG_SAFE_REMOTE="r2:$R2_BUCKET"
export RCLONE_CONFIG_SAFE_FILENAME_ENCRYPTION=off
export RCLONE_CONFIG_SAFE_DIRECTORY_NAME_ENCRYPTION=false
RCLONE_CONFIG_SAFE_PASSWORD="$(rclone obscure "$BACKUP_PASSPHRASE")"
export RCLONE_CONFIG_SAFE_PASSWORD

# One folder per run (the R2 lock forbids overwriting a recent object, so a second run on the same day needs its own).
run="$(date -u +%FT%H%MZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- 1. One snapshot: counts and dump ------------------------------------------------------------------------------
# A psql session holds a REPEATABLE READ transaction open and exports its snapshot; the counts are read in that
# session and pg_dump reads the same snapshot.
coproc SNAP { psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1; }
printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" >&"${SNAP[1]}"
read -r -t 60 snapshot <&"${SNAP[0]}"
log "snapshot $snapshot"

COUNTS_SQL="SELECT json_object_agg(table_name, n ORDER BY table_name) FROM (
  SELECT table_name,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS n
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') t;"
MIGRATION_SQL="SELECT coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
MODEL_SQL="SELECT coalesce((SELECT value FROM ops_state WHERE key = 'embedding_model'), '');"
for sql in "$COUNTS_SQL" "$MIGRATION_SQL" "$MODEL_SQL"; do
  printf '%s\n' "$(tr '\n' ' ' <<<"$sql")" >&"${SNAP[1]}"
done
read -r -t 600 counts <&"${SNAP[0]}"
read -r -t 60 migration <&"${SNAP[0]}"
read -r -t 60 embedding_model <&"${SNAP[0]}"

[ -n "$counts" ] || counts='{}'  # an empty schema still gives valid JSON
pg_dump --format=custom --compress=6 --no-owner --no-privileges --snapshot="$snapshot" \
  --file="$work/db.dump" "$DATABASE_URL"
printf '%s\n' "COMMIT;" "\\q" >&"${SNAP[1]}"
wait "$SNAP_PID" || true
log "dump $(stat -c %s "$work/db.dump") bytes, newest migration $migration"

# --- 2. Upload the dump and the manifest ---------------------------------------------------------------------------
dump_sha="$(sha256sum "$work/db.dump" | cut -d' ' -f1)"
printf '{"created_at":"%s","snapshot":"%s","migration":"%s","embedding_model":"%s","dump_bytes":%s,"dump_sha256":"%s","uploads_bucket":"%s","row_counts":%s}\n' \
  "$(date -u +%FT%TZ)" "$snapshot" "$migration" "$embedding_model" "$(stat -c %s "$work/db.dump")" "$dump_sha" \
  "$S3_BUCKET" "$counts" >"$work/manifest.json"

rclone copyto "$work/db.dump" "safe:daily/$run/db.dump"
rclone copyto "$work/manifest.json" "safe:daily/$run/manifest.json"
if [ "$(date -u +%u)" = 7 ]; then
  rclone copyto "$work/db.dump" "safe:weekly/$run/db.dump"
  rclone copyto "$work/manifest.json" "safe:weekly/$run/manifest.json"
  log "weekly copy written"
fi

# --- 3. Mirror the uploads bucket ----------------------------------------------------------------------------------
rclone sync "uploads:$S3_BUCKET" "safe:uploads/current" --backup-dir "safe:uploads/deleted/$run" \
  --fast-list --transfers 8 --stats-one-line --stats 0
log "uploads mirrored"

# --- 4. Record success ---------------------------------------------------------------------------------------------
echo "INSERT INTO ops_state (key, value, updated_at) VALUES
    ('backup_last_success', :'at', now() AT TIME ZONE 'UTC'), ('backup_last_name', :'name', now() AT TIME ZONE 'UTC')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;" |
  psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1 -v at="$(date -u +%FT%T+00:00)" -v name="daily/$run"
log "done: daily/$run"
