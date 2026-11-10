# Backups and restoring Margins

What has to come back together after losing the Railway project, where each piece is kept, and how to restore it.
The quarterly drill (below) runs the same restore into a scratch database, so these steps are tested.

## What is backed up

The `backup` service (`backup/backup.sh`, a Railway cron job at 10:30 UTC) writes to the Cloudflare R2 bucket
`margins-backups`. Everything is encrypted with rclone crypt before it leaves Railway; file names stay readable.

| Path in R2 | What | Kept |
|---|---|---|
| `daily/<run time>/db.dump` (e.g. `daily/2026-11-10T1030Z/`) | `pg_dump --format=custom` of the whole database: schema, migrations table, indexes, vectors | 35 days |
| `daily/<run time>/manifest.json` | Row count of every table (same snapshot as the dump), newest migration, embedding model, dump checksum, uploads bucket name | 35 days |
| `weekly/<run time>/…` | Sunday's dump and manifest | 120 days |
| `uploads/current/` | Mirror of the uploads bucket as of the last run, including `ops/deletions/` | Until the next run |
| `uploads/deleted/<run time>/` | Files deleted or replaced in the bucket since the run before | 35 days |

A bucket lock rule keeps every object under `daily/`, `weekly/` and `uploads/deleted/` for at least 7 days, so a
leaked R2 key cannot delete the recent backups. `uploads/current/` cannot be locked, since each run rewrites it: a
leaked key could empty the mirror, and the files would then come back only from the deleted copies of the last 35
days.

The bucket's rules (Cloudflare dashboard, R2, `margins-backups`, Settings; set them again on a new bucket):

| Rule | Prefix | Setting |
|---|---|---|
| Lock `keep-daily-7-days` | `daily/` | Age, 7 days |
| Lock `keep-weekly-7-days` | `weekly/` | Age, 7 days |
| Lock `keep-deleted-uploads-7-days` | `uploads/deleted/` | Age, 7 days |
| Lifecycle `daily-35d` | `daily/` | Delete after 35 days |
| Lifecycle `weekly-120d` | `weekly/` | Delete after 120 days |
| Lifecycle `uploads-deleted-35d` | `uploads/deleted/` | Delete after 35 days |
| Lifecycle `abort-multipart-7d` | all | Abort incomplete multipart uploads after 7 days |

 After a successful run the service writes `ops_state.backup_last_success`; the AI
service's watchdog alerts when that is older than 36 hours, and a failed run records `backup_failed`, which the
watchdog reports within 5 minutes.

What is not in the backup: anything newer than the last run (up to a day of work), and secrets (below).

## Secrets inventory

Names and where each is held, never values. Railway holds every one of them; the second column is where to get it
when Railway is gone.

| Variable | Service | Held outside Railway | If lost |
|---|---|---|---|
| `BACKUP_PASSPHRASE` | backup | The box (`~/.config/margins/backup-passphrase`, mode 600) and Harish's password manager | **The backups cannot be read.** Keep both copies. |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | backup | The box (`~/.config/margins/r2-backups.env`); Cloudflare dashboard, R2, API tokens | Make a new R2 API token (read and write on `margins-backups`) |
| `ANTHROPIC_API_KEY` | ai | Anthropic console | Make a new key |
| `AI_INTERNAL_TOKEN` | ai (web references it) | Nowhere; random | `openssl rand -hex 32` |
| `NEXTAUTH_SECRET` | web | Nowhere; random | `openssl rand -base64 48` (everyone signs in again) |
| `SPEND_KEY_SECRET` | web | Nowhere; random. Keep a copy in the password manager | Generate 32 random bytes in hex. A new value starts every returning student's daily allowance and voice minutes over, so keep the old one |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | web | Google Cloud project "studybuddy", OAuth client "Margins web" | Add a new secret to the same client |
| `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY` | web | The providers' consoles | Make new keys |
| `OPS_ALERT_WEBHOOK_URL` | ai | The box's `box-health` service (`NTFY_TOPIC`) | Use the same ntfy topic |
| `DATABASE_URL`, bucket `S3_*` | all | Nowhere; Railway makes them | New ones come with the new Postgres and bucket |

Outside Railway as well: the domain `studymargins.com` and its DNS (the registrar's records point at Railway's web
domain; Railway shows the target when a custom domain is added), and the Google OAuth client's redirect URI
`https://studymargins.com/api/auth/callback/google`, which stays valid as long as the domain does.

## Restoring

Needs a machine with `rclone`, and the Postgres 18 client (`psql`, `pg_restore`): the box has them.

1. **Project.** Recreate the Railway project from `.railway/railway.ts` (`railway config apply`), set every secret
   above (`railway variable set -s <service> NAME --stdin`), and point the domain at the new `web` service. Stop
   `web` and `ai` until the data is back: they would otherwise start on an empty database.
2. **Database.** Make the new Postgres reachable from the restore machine (a TCP proxy on `Postgres`, or run the
   restore inside a `railway ssh` session), then restore the newest backup into it and replay the deletions:

   ```bash
   python3 scripts/restore_drill.py --into "$NEW_DATABASE_PUBLIC_URL"
   ```

   The database must be empty. The script runs the same checks as the drill and keeps the result. It takes the
   newest complete backup (a run that died before writing its manifest is skipped). Use
   `--backup daily/<run time>` for an older one.
3. **Files.** Copy the mirror into the new uploads bucket, with the same rclone settings as `backup/backup.sh`
   (`safe:` is the decrypted view of R2, `uploads:` the new bucket). A file deleted after the backup's dump is in
   `uploads/deleted/<run time>/` instead; copy it back from there if its material is in the restored database:

   ```bash
   rclone copy safe:uploads/current uploads:<new bucket name>
   ```

4. **Bucket name.** Stored paths name the bucket (`s3://<bucket>/<key>`, in `materials.gcs_path` only). If the new
   bucket's name differs from `uploads_bucket` in the manifest:

   ```sql
   UPDATE materials SET gcs_path = regexp_replace(gcs_path, '^s3://<old bucket>/', 's3://<new bucket>/')
   WHERE gcs_path LIKE 's3://<old bucket>/%';
   ```

5. **Embedding model.** The manifest's `embedding_model` must equal `EMBEDDING_MODEL` in the AI service (the drill
   checks). If it does not, re-embed (`docs/deployment/RAILWAY.md`, Database) before search is used.
6. **Start** `ai`, then `web`. `https://studymargins.com/api/health/ready` answers `{"status":"ok"}` once the
   database, the AI service and its watchdog are all running.

Accounts deleted after the backup was taken come back with the database; step 2 deletes them again from the records
in `ops/deletions/`. An account deleted after the last mirror run is not recorded there, which is the same day of
loss as everything else.

## The quarterly drill

On the box, against the scratch Postgres 18 with pgvector (any server works: `--admin-url`):

```bash
python3 scripts/restore_drill.py
```

It restores the newest complete daily backup into a scratch database, compares every table's row count with the manifest,
checks the migration and the embedding model, runs a nearest-neighbour query, looks for 20 sampled material files in
the mirror, replays the deletion records, and drops the scratch database. It prints a line to add under "Restore
drills" in `docs/deployment/RAILWAY.md`. A failure prints what did not match and exits 1.
