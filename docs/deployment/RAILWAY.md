# Deploying on Railway

Margins (studymargins.com) runs as one Railway project, `study-buddy`, in the `us-west2` region:

| Resource | What it is |
|---|---|
| `web` | The Next.js app (`frontend/Dockerfile`). Public domain, port 3000. |
| `ai` | The FastAPI service (`ai-service/Dockerfile`). Private network only, port 8000. |
| `Postgres` | Railway Postgres. Its image ships pgvector; the first migration enables it. |
| `uploads` | A Railway bucket (S3-compatible, `sjc`) holding the uploaded study files. |

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
- Health checks: `web` on `/login`, `ai` on `/health`.

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

Google is the only way to sign in, so `web` refuses to start without a real Google OAuth client
(placeholders count as missing). The client needs `https://<web domain>/api/auth/callback/google` as a
redirect URI. Never set `ENABLE_TEST_LOGIN` on Railway: it is a local-only test sign-in, and `web` refuses
to start with it.

Optional:

- **Voice coach.** Set `OPENAI_API_KEY` on `ai` (also as `preserve()` in `railway.ts`).

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
