# Deploying on Railway

Margins (studymargins.com) runs as one Railway project in the `us-west2` region. The project is still
named `study-buddy`, from before the app was renamed:

| Resource | What it is |
|---|---|
| `web` | The Next.js app (`frontend/Dockerfile`). Public domain, port 3000. |
| `ai` | The FastAPI service (`ai-service/Dockerfile`). Private network only, port 8000. |
| `Postgres` | Railway Postgres. Its image ships pgvector; the first migration enables it. |
| `uploads` | A Railway bucket (S3-compatible, `sjc`) holding the uploaded study files. |
| `backup` | A cron job (`backup/Dockerfile`, 10:30 UTC): the nightly encrypted backup to Cloudflare R2. See [RESTORE.md](RESTORE.md). |

The whole project is described in [`.railway/railway.ts`](../../.railway/railway.ts): services,
build and deploy settings, regions and every variable. Change settings there, not in the
dashboard, or the next apply puts them back.

## How the pieces connect

- `web` calls `ai` at `http://ai.railway.internal:8000` with the shared `AI_INTERNAL_TOKEN`.
  `ai` has no public domain.
- Both services get the bucket's credentials through variable references
  (`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). `web`
  streams each upload through the size and file-type checks into the bucket and stores the
  material as `s3://bucket/key`; `ai` downloads it from there to process it. A volume can't be
  shared between two services, which is why files live in a bucket.
- Before each `web` deploy takes traffic, Railway runs `prisma migrate deploy` as the
  pre-deploy command. A failed migration stops the deploy, and the old version keeps running.
- Health checks: `web` on `/login`, `ai` on `/health`. The AI service's `/health` answers 503 until the database
  has the migration its code names (`ai-service/app/db/schema_version.py`), so a new `ai` waits, up to 15 minutes,
  for the `web` deploy that applies it. `/health` and the web app's `/api/health/ready` (the uptime check: database,
  AI service and watchdog) say only `ok` or `unavailable`; the detail is at `ai`'s `/health/dependencies` and `web`'s
  `/api/health/runtime`, for a signed-in user or a request carrying `AI_INTERNAL_TOKEN`.

## Everyday commands

Run these from the repository root. The CLI needs to be logged in (`railway login`) and linked
to the project (`railway link`, choose `study-buddy`).

```bash
npm install                 # once: the `railway` SDK that evaluates .railway/railway.ts

railway config plan         # preview what would change; read it before applying
railway config apply        # apply it

# Deploy the working tree of one service
railway up frontend   --path-as-root -s web
railway up ai-service --path-as-root -s ai

railway logs -s web          # runtime logs (add -b for build logs)
railway service status -s ai
```

### Deploying on every push

Railway deploys each
service on every push to `main`, after CI passes and only when that service's folder changed. This is on; to set it up again elsewhere:

1. In the Railway dashboard, open the `web` service, Settings, Source, and connect the
   GitHub repository. That installs the Railway GitHub app; give it access to `margins`.
   The deploy this starts builds from the repository root and fails; step 2 fixes that.
2. Set `AUTO_DEPLOY_FROM_GITHUB = true` in `.railway/railway.ts`, then `railway config plan`
   and `railway config apply`. This points both services at `main` with their own folder as
   the root directory.

`railway config apply` asks before deleting anything, and refuses destructive changes in
non-interactive sessions unless you add `--confirm-destructive`.

## Secrets

`.railway/railway.ts` marks secrets with `preserve()`, so the file never holds their values:

| Variable | Service | Set with |
|---|---|---|
| `ANTHROPIC_API_KEY` | ai | `railway variable set -s ai ANTHROPIC_API_KEY --stdin` |
| `AI_INTERNAL_TOKEN` | ai (web references it) | `openssl rand -hex 32`, then as above |
| `NEXTAUTH_SECRET` | web | `openssl rand -base64 48`, then as above |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | web | The OAuth client in Google Cloud, as above |
| `DEEPGRAM_API_KEY` | web | Optional. Cloud speech recognition for voice practice, tried first. A project key with the Member role or above: lower roles cannot mint the browser tokens (`/v1/auth/grant` answers "Insufficient permissions"). |
| `ASSEMBLYAI_API_KEY` | web | Optional, and unused unless `CLOUD_SPEECH_PROVIDERS` names `assemblyai` (see below). Without a usable cloud provider, voice uses the browser's own recognizer. |
| `OPS_ALERT_WEBHOOK_URL` | ai | The ntfy topic URL (`https://ntfy.sh/<topic>`; Discord and Slack webhooks work too). Where the watchdog's alerts go; see Alerts. |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | backup | Cloudflare R2: the `margins-backups` bucket and an API token with read and write on it. |
| `BACKUP_PASSPHRASE` | backup | Encrypts the backups. Without it they cannot be read: keep a copy outside Railway ([RESTORE.md](RESTORE.md)). |

Google is the only way to sign in, so `web` refuses to start without a real Google OAuth client
(placeholders count as missing). The client needs `https://<web domain>/api/auth/callback/google` as a
redirect URI. Never set `ENABLE_TEST_LOGIN` on Railway: it is a local-only test sign-in, and `web` refuses
to start with it.

## Optional settings

`web` reads `CLOUD_SPEECH_PROVIDERS` (default `deepgram`: the cloud speech providers to try, in order; add `assemblyai` only on an AssemblyAI account opted out of model training, or the privacy page is wrong), `DEEPGRAM_STREAMING_MODEL` (default `nova-3`) and `ASSEMBLYAI_STREAMING_MODEL` (default `universal-3-6-pro`). Set them only to change the order or try another model.

These are read by `ai` and have working defaults. None is declared in `.railway/railway.ts`, so set one with `railway variable set -s ai NAME --stdin` only if you want to change it.

| Variable | Default | What it does |
|---|---|---|
| `OPS_ALERT_COOLDOWN_SECONDS` | `21600` (6 hours) | The shortest time between two alerts of the same kind. |
| `WATCHDOG_INTERVAL_SECONDS` | `300` | How often the watchdog runs. |
| `WATCHDOG_FAILED_JOBS_PER_HOUR` | `5` | Failed jobs with one error code in an hour that make an alert. |
| `BACKUP_MAX_AGE_HOURS` | `36` | The age of the newest backup that makes an alert (with `BACKUPS_EXPECTED`, set in `railway.ts`). |
| `OPS_DEADMAN_URL` | empty | A dead-man check (a healthchecks.io ping URL, say) the watchdog calls on every run. The box's uptime check of `/api/health/ready` already fails when the watchdog stops. |
| `AI_STATUS_TTL_S` | `300` | Seconds before a recorded outage counts as unknown, so the next real call tests the provider again. |
| `AI_STATUS_TRANSIENT_THRESHOLD` | `3` | Rate limits or overloads in a row (after the SDK's own retries) that mark the AI unavailable. Credit, key and configuration errors mark it at once. |
| `JOB_AI_WAIT_MAX_SECONDS` | `604800` (7 days) | How long exam grading waits for the AI before it fails with the reason it was waiting. |

## Alerts

The AI service's watchdog (`ai-service/app/services/watchdog.py`) runs every 5 minutes. It reads what went wrong
from the database and posts to `OPS_ALERT_WEBHOOK_URL`, titled "Margins: …", at most once per kind every 6 hours.
The box checks `https://studymargins.com/api/health/ready` every 15 minutes and alerts on the same ntfy topic when it
fails, which also covers a watchdog that stopped. An alert carries counts, kinds and error codes only: ids, file
paths and error text are in the `ai` log line "Watchdog: <kind>: …", since the ntfy topic is a third party.
A post the webhook does not take is tried again on the next run.

| Alert | What it means | What to do |
|---|---|---|
| AI unavailable, then available again | Claude calls fail: out of credit, a bad key, or repeated overloads. Students see AI features paused. | Credit: top up in the Anthropic console. Key: replace `ANTHROPIC_API_KEY`. Overloads clear by themselves. |
| spend at 80%, spend cap reached | Today's spend across all users against `GLOBAL_DAILY_LLM_BUDGET_USD`. At 100% every AI call is refused until 00:00 UTC. | Check `llm_usage_events` for one user or purpose spending far more than usual; raise the cap only on purpose. |
| jobs failing | 5 or more jobs failed with one error code within the hour; the alert names the code. | The `ai` logs around the job ids; `processing_jobs.error_message`. |
| jobs stuck | A processing job's lease ran out over 15 minutes ago and nothing picked it up. | Is `ai` running? Its reaper restarts such jobs; restart `ai` if not. |
| voice purge not running | Voice transcripts were not purged in over 2 days: the privacy page's retention promise is not being kept. | `ai` logs for `voice_retention_failed`; run `POST /voice/retention` by hand. |
| evidence lost | Quiz or exam results whose concept evidence was given up after 5 tries. The student's score stands; mastery missed it. | The web logs for "Giving up writing"; usually a database error at the time. |
| backup missing, backup failed | No successful nightly backup in 36 hours, or the last run failed. | The `backup` service's last run on Railway; [RESTORE.md](RESTORE.md). |
| embedding model mismatch | The stored vectors were made by another model than `EMBEDDING_MODEL`. Search results are meaningless. | Re-embed (Database, below) or set `EMBEDDING_MODEL` back. |
| orphaned files | Files in the bucket that no material points to, over a day old. | Usually a delete that failed; the `ai` log names up to five keys. Delete them after checking. |
| storage delete failed | The web app could not delete a stored file (a deleted course or account, a failed upload). | The web logs name the path; delete it from the bucket by hand. |
| account delete failed | An account deletion stopped part way. The student can retry, and the account still exists. | The web logs for `[ACCOUNT]`; usually storage. |
| deletion record failed | An account was deleted but `ops/deletions/<id>.json` could not be written, so a restore would bring it back. | Write the record by hand (`{"userId": "<id>", "deletedAt": "<time>"}`). |
| dispatch failed, lease renewal failed, ledger write failed, job write failed, reaper failed, ai status read/write failed | A database or network error where the code carries on. The spend ledger one means spend went unrecorded. | The `ai` logs at that time; usually the database was briefly unreachable. |
| errors logged | The AI service logged more than 20 errors between two watchdog runs. | The `ai` logs; the watchdog log line quotes the first. |
| watchdog check failed | One of the checks above raised. | The `ai` logs for "Watchdog check"; the other checks still ran. |

## Backups and restore drills

Nightly to Cloudflare R2; what is kept, the secrets inventory and the restore steps are in [RESTORE.md](RESTORE.md).
Run the drill (`python3 scripts/restore_drill.py` on the box) once a quarter and add its line here.

Restore drills:
- 2026-11-10: restore drill passed (backup daily/2026-11-10T0647Z, the first; 42 tables, 881 rows, counts match;
  725 vectors searchable; 16 of 16 sampled files found).

## Database

There is no public database port. For a one-off SQL session, add a TCP proxy to `Postgres`,
use `DATABASE_PUBLIC_URL`, and remove the proxy afterwards, or use `railway ssh -s Postgres`.

After changing the embedding model, re-embed the stored chunks from a machine that can reach
the database:

```bash
cd ai-service
DATABASE_URL=... uv run python scripts/reembed_chunks.py --missing-only
```

## Cost

The services bill by the minute for the memory and CPU they use. Measured at idle just after
setup: `ai` about 0.5 GB (mostly the local embedding model), `web` about 0.13 GB and `Postgres`
about 0.11 GB, which is roughly $7–8 a month at $10 per GB-month.
The Hobby plan includes $5 of usage a month across every project in the account, and the
bucket's storage is $0.015 per GB-month with free egress. `railway usage` shows what has been
used so far. Claude calls are billed by Anthropic, capped per user by `DAILY_LLM_BUDGET_USD` and for all users together by `GLOBAL_DAILY_LLM_BUDGET_USD` (default 40, per UTC day).
