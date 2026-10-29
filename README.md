<div align="center">

# Margins

**Study from your own course files.**

Upload your lecture notes, textbook chapters and past exams. Margins splits them into topics, then writes notes, worked examples, quizzes and timed practice exams from that material, with sources you can click back to. A voice coach quizzes you out loud.

**[studymargins.com](https://studymargins.com)**

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Claude](https://img.shields.io/badge/LLM-Claude-D97757)](https://docs.anthropic.com/)

<img src="frontend/public/screens/plan-light.webp" alt="The Margins plan page: Today lists a review and a quiz, and each day after it leads to the exam date" width="860">

</div>

## What it does

1. **Upload** PDF, DOCX, PPTX or DOC files: lecture notes, book chapters, sample exams.
2. **Review the course plan** Margins proposes: units (the syllabus's chapters or weeks) of topics, each tied to the pages that teach it, with learning objectives, prerequisites and an estimated time. Rename, merge, move, add or remove topics before anything is generated.
3. **Study each topic** in five views:
   - **Notes**: a lesson (what you'll learn, the idea, key concepts, a worked example, a check-yourself question, pitfalls and a summary), rendered with KaTeX math and highlighted code, written from that topic's own pages and listing the files and pages it came from.
   - **Worked examples**: solved problems with step-by-step reasoning.
   - **Practice**: problems you solve one step at a time, with hints and a check for each step.
   - **Quiz**: multiple choice, true/false, numerical and short answer. Scores are computed on the server; short answers are graded by the model with partial credit.
   - **Voice practice**: a spoken session with three styles (quiz me, walk me through it, just talk) in ten languages.
4. **Take practice exams** across topics: timed, autosaved, with per-question feedback and regrading. Upload past exams and **Match my past exams** writes new ones in their style (question mix, points, phrasing, conventions); the topics those exams test are flagged.
5. **Plan to your exam date.** Give the date and your daily minutes and Margins lays out each day: new topics in prerequisite order, a quiz the next day, spaced reviews, a mock exam after each unit and two full mocks before the exam. Mastery comes from quizzes, exams, voice and practice; **Retry what you missed** and **Fresh review** target weak spots.
6. **Ask your materials**: a chat that answers from your files with numbered citations, and says so when the files don't cover the question.

<img src="frontend/public/screens/topics-edit-light.webp" alt="The course plan: units and topics, each tied to the file and pages it is taught from" width="860">

*The course plan Margins proposes. Each topic lists the file and pages it is taught from, and you can rename, move, merge or remove topics before anything is written.*

<img src="frontend/public/screens/notes-detail-light.webp" alt="Topic notes with code, an outline and the source files and pages" width="860">

*Notes for one topic, with an outline and the source pages they were written from.*

<img src="frontend/public/screens/practice-light.webp" alt="A practice problem solved one step at a time, with a hint open" width="860">

*Practice: a problem broken into steps, each checked as you go, with a hint.*

<img src="frontend/public/screens/ask-light.webp" alt="Ask your materials, with a citation open on the page it quotes" width="860">

*Ask your materials: answers cite numbered passages from your files, and each citation opens the page.*

Every image here and on [the landing page](https://studymargins.com) comes from the real app, with a hand-written showcase course. `npm run screens` in `frontend/` refreshes them (see [Screenshots](#screenshots)).

## How it works

```
Browser ──▶ Next.js 16 (web) ──────────────▶ FastAPI (ai) ──▶ Claude (Anthropic API)
            UI, auth, API routes,            parsing, chunking,
            jobs, voice turn loop            embeddings, generation, grading
              │          │                     │          │
              │          │ stores and          │ reads    │
              │          ▼ serves files        │ files    │
              │     S3-compatible bucket ◀─────┘          │
              │                                           │
              └───────────▶ Postgres + pgvector ◀─────────┘
```

- **Parsing and chunking.** Files are read as markdown (PDFs with pymupdf4llm; DOCX, PPTX, and DOC through LibreOffice when installed) and split at headings and paragraphs into chunks of about 350 tokens, each tagged with its heading path and pages.
- **Local embeddings.** Chunks are embedded in-process with `BAAI/bge-small-en-v1.5` (384 dimensions, no API cost) and stored in pgvector with an HNSW index.
- **Topic-scoped retrieval.** Each topic is mapped to at most 24 chunks by hybrid search: vector similarity and Postgres full-text search, merged with Reciprocal Rank Fusion, with a similarity floor so a barely covered topic gets a short list instead of loose matches. Generators only ever see those chunks, so prompt size stays flat as a course grows, and the shared excerpt block is prompt-cached across notes, examples, quizzes and exams.
- **Models.** Claude Opus writes notes, examples, quizzes and exams, plans each course in one low-effort call and answers Ask questions; Claude Haiku handles file validation, short-answer grading and the voice coach.
- **Voice without a speech API.** The browser does speech-to-text and text-to-speech (Web Speech API). The server runs Claude with drill tools (next question, record answer, hint) and streams each turn back as NDJSON.
- **Jobs.** Long tasks run as jobs that are claimed with one atomic update and hold a lease; a reaper re-dispatches jobs whose worker died. Each job records its tokens and cost; a per-user daily budget and a site-wide daily cap bound spend.
- **Isolation.** Only the web service can call the AI service (shared internal token), which is reachable only on Railway's private network.
- **Storage.** The web app streams each upload through size and file-type checks into an S3-compatible bucket (a Railway bucket in production); the AI service downloads it from there to process it. Without a bucket, both use a local uploads folder.

## Evals

### Retrieval

Everything a topic teaches comes from its 24 mapped chunks, so the mapping is measured. [`evals/`](evals/README.md) holds a retrieval eval over 38 topics in three OpenStax textbook chapters (CS, biology, psychology; about 300 chunks), using the app's real chunker, embedder and search. It needs no API key and runs in under a minute.

| Retrieval (macro average, K = 24) | recall@24 | MRR | nDCG@24 | hit@5 |
|---|---|---|---|---|
| Before: keyword `ILIKE` + vector, flat keyword score | 0.935 | 0.830 | 0.777 | 0.895 |
| Now: vector + full-text, Reciprocal Rank Fusion | **0.989** | **0.961** | **0.932** | **1.000** |

Full results are in [`evals/results/`](evals/results/).

### Generation

The [generation eval](evals/README.md#generation-eval) runs the app's own generators (notes, worked examples, practice problems, quizzes) on two real MIT OpenCourseWare courses, 18.05 (probability and statistics) and 6.006 (algorithms), then checks the output two ways: automatic checks in code, and scores from a model judge. It makes paid API calls behind a spend cap.

The judge is the same model that wrote the content (Claude Opus at medium effort). It sees the source excerpts and is not told which model wrote what, but a model grading its own output is not an independent reviewer, so read the judge scores as limited evidence. The automatic checks involve no model. The ones below include every check the output failed; the report has the rest.

Latest run: [2026-10-21](evals/results/2026-10-21-structure.md), 8 topics, Opus writing and judging.

| Judge scores (out of 5) | |
|---|---|
| Correctness | 4.88 |
| Grounding in the source pages | 4.91 |
| Teaching quality | 4.78 |
| Quiz question quality | 4.50 |
| Errors the judge listed, over 32 items | 8 (2 mathematical) |

| Automatic checks | Result |
|---|---|
| Notes with all expected sections | **0 of 8 (failed)** |
| Notes inside the requested word band | **0 of 8 (failed; mean 1,749 words)** |
| Plain-text fields with stray `$` or backslash sequences (flagged for reading) | 38 |
| Quiz questions that restate a worked example | 12% (4 of 32) |
| Notes with 5-8 recap bullets | 8 of 8 |
| Worked-example, practice and quiz sets with the requested count | 8 of 8 each |
| Cost per topic (all four types) | $0.585 |

The same judge also picked the model: [Sonnet and Haiku made maths errors and fell short of the bar set before the run](evals/results/2026-10-21-model-decision.md), so generation stays on Opus and cost is held down by generating each topic only when it is opened.

## Screenshots

The product screenshots on the landing page, on the sign-in page and in this README are generated from the running app, so they never show an old navigation. [`frontend/scripts/capture-screens.ts`](frontend/scripts/capture-screens.ts) seeds a showcase student and course (written by hand in [`frontend/scripts/screens/`](frontend/scripts/screens/), no model output), signs in, and captures each screen in light and dark as WebP into `frontend/public/screens/`, with phone-sized crops for the landing page.

```bash
# a migrated database and the e2e stack (scripts/e2e-stack.sh start), then:
cd frontend
DATABASE_URL=postgresql://... PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run screens
npm run screens -- --only plan,ask      # a few screens
npm run screens -- --no-seed            # reuse the showcase account already in the database
```

It only runs against a local web app and a local database, signs in with the test sign-in (below), and needs no AI calls: nothing is generated while it runs.

## Run it locally

Everything runs without an API key: the `.env.example` files set `LLM_PROVIDER=mock`, which returns placeholder notes, quizzes and grades with no API calls. For real output, set `LLM_PROVIDER=anthropic` and an [Anthropic API key](https://console.anthropic.com/settings/keys) (`ANTHROPIC_API_KEY`).

With Docker (Postgres, the migrations, the web app on :3000 and the AI service on :8000):

```bash
git clone https://github.com/harishm17/margins.git
cd margins
cp .env.example .env
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> .env
echo "ENABLE_TEST_LOGIN=true" >> .env   # local test sign-in; or set the Google variables instead
echo "AI_INTERNAL_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up --build
```

Compose applies the database migrations in a one-shot `migrate` service before the web app and the AI service start. Then open http://localhost:3000 and sign in with the test sign-in (`you@example.com`, any `@example.com` address, no password).

Students sign in with Google only. The `ENABLE_TEST_LOGIN=true` line above turns on a test sign-in on `/login` that takes any `@example.com` address with no password; the e2e stack and the screenshot script use it. To use Google instead, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (an OAuth client with `http://localhost:3000/api/auth/callback/google` as a redirect URI). The test sign-in only works while `NEXTAUTH_URL` is on localhost, and the web app refuses to start with it set on any other site or on Railway.

<details>
<summary>Without Docker</summary>

You need Node 24+, Python 3.13+ with [uv](https://docs.astral.sh/uv/), and Postgres 15+ with pgvector 0.5+. The `.env.example` files connect as user `dev`, password `devpass`, to the database `margins`; to use another, change `DATABASE_URL` in `frontend/.env` and `ai-service/.env`.

```bash
# From the repository root: the database, then the migrations
psql -d postgres -c "CREATE ROLE dev LOGIN PASSWORD 'devpass'"
createdb -O dev margins
psql -d margins -c 'CREATE EXTENSION IF NOT EXISTS vector'
(cd frontend && cp .env.example .env && echo 'ENABLE_TEST_LOGIN="true"' >> .env && npm install && npx prisma migrate deploy)
(cd ai-service && cp .env.example .env && uv sync)
```

```bash
# Terminal 1, from the repository root: the AI service on :8000
cd ai-service && uv run uvicorn app.main:app --reload
```

```bash
# Terminal 2, from the repository root: the web app on :3000
cd frontend && npm run dev
```

Then open http://localhost:3000 and use the test sign-in (any `@example.com` address, no password). Uploads go to `/data/uploads`, or `/tmp/margins-uploads` when that folder is not writable; both services look in the same two places. The first upload downloads the small embedding model, so it takes longer than the rest.

</details>

<details>
<summary>Environment variables</summary>

Required (the `.env.example` files have working local values):

```env
DATABASE_URL=postgresql://dev:devpass@localhost:5432/margins
NEXTAUTH_SECRET=...              # openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000
AI_SERVICE_URL=http://localhost:8000
AI_INTERNAL_TOKEN=...            # openssl rand -hex 32, same value in both services
GOOGLE_OAUTH_CLIENT_ID=...       # Google sign-in, the only way to sign in: production will not start without it
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Optional:

```env
ENABLE_TEST_LOGIN=true           # local only: a test sign-in for @example.com addresses, instead of Google
LLM_PROVIDER=mock                # or anthropic, with ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5-5
ANTHROPIC_FAST_MODEL=claude-haiku-5-5
MODEL_CHAT=:low                  # one model per purpose, "<model>:<effort>" (":low" keeps the default model at low
                                 # effort): MODEL_NOTES, _EXAMPLES, _PRACTICE, _QUIZ, _EXAM, _GRADING, _TOPICS,
                                 # _CHAT, _VOICE, _VALIDATION. ai-service/.env.example lists the defaults.
LLM_MAX_CONCURRENCY=4            # model calls at once in the AI service
VOICE_DAILY_MINUTES=30           # per user per 24 hours
MAX_UPLOAD_MB=25
S3_BUCKET=... S3_ENDPOINT=... S3_REGION=auto S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
```

Without `S3_BUCKET`, uploads go to the local uploads folder (`LOCAL_UPLOADS_DIR`).

</details>

<details>
<summary>Migrations and re-embedding</summary>

The schema is managed with Prisma migrations in `frontend/prisma/migrations`; after a schema change run `npm run db:migrate -- --name <what_changed>`. A database created earlier with `prisma db push` needs `npx prisma migrate resolve --applied 0_init` once before `migrate deploy`.

Migration `20261022000000_retrieval_indexes` makes embeddings `vector(384)` and clears vectors of any other size. Re-embed afterwards with `uv run python scripts/reembed_chunks.py` (or `--missing-only`) in `ai-service/`.

</details>

## Tests

```bash
(cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build)
(cd ai-service && uv run pytest -q)
```

The Playwright specs run against the production build, the AI service on the mock LLM and a migrated database:

```bash
export DATABASE_URL=postgresql://dev:devpass@localhost:5432/margins
(cd frontend && npx playwright install chromium)   # once
scripts/e2e-stack.sh start            # after the build above
(cd frontend && PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test)
scripts/e2e-stack.sh stop
```

CI (`.github/workflows/ci.yml`) runs the same steps: Prisma validation, lint, type check, unit tests and a production build for the web app, the pytest suite for the AI service, and the Playwright specs against Postgres with pgvector.

## Deployment

Hosted on [Railway](https://railway.com/): the web and AI services, Postgres with pgvector, and a Railway bucket for uploads. The whole project is declared in [`.railway/railway.ts`](.railway/railway.ts), and pushes to `main` deploy automatically. See [docs/deployment/RAILWAY.md](docs/deployment/RAILWAY.md).

## Project layout

```
.railway/railway.ts   Railway project as code
frontend/             Next.js app: pages, API routes, Prisma schema, Playwright e2e
ai-service/           FastAPI service: parsing, embeddings, generation, grading
evals/                retrieval and generation evals, results
docs/                 deployment guide (RAILWAY.md) and old design screenshots
```

## License

MIT. See [LICENSE](LICENSE).

Built by [Harish Manoharan](https://harishmanoharan.com) · [GitHub](https://github.com/harishm17) · [LinkedIn](https://linkedin.com/in/harishm17)
