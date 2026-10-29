<div align="center">

# Margins

**Study from your own course files.**

Upload your lecture notes, textbook chapters and past exams. Margins splits them into topics, then writes notes, worked examples, quizzes and timed practice exams from that material, with sources you can click back to. A voice coach quizzes you out loud.

**[studymargins.com](https://studymargins.com)**

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Claude](https://img.shields.io/badge/LLM-Claude-D97757)](https://docs.anthropic.com/)

<img src="frontend/public/screens/plan-light-1920.webp" alt="The Margins plan page: Today lists a review and a quiz, and each day after it leads to the exam date" width="860">

</div>

## What it does

1. **Upload** PDF, DOCX, PPTX or DOC files: lecture notes, book chapters, sample exams.
2. **Review the course plan** Margins proposes: units (the syllabus's chapters or weeks) of topics, each tied to the pages that teach it, with learning objectives, prerequisites and an estimated time. Rename, merge, move, add or remove topics before anything is generated.
3. **Study each topic** in four views:
   - **Notes**: a lesson (what you'll learn, the idea, key concepts, a worked example, a check-yourself question, pitfalls and a summary), rendered with KaTeX math and highlighted code, written from that topic's own pages and listing the files and pages it came from.
   - **Examples**: solved problems with step-by-step reasoning, and interactive problems you solve one step at a time with hints.
   - **Quiz**: multiple choice, true/false, numerical and short answer. Scores are computed on the server; short answers are graded by the model with partial credit.
   - **Voice practice**: a spoken session with three styles (quiz me, walk me through it, just talk) in ten languages.
4. **Take practice exams** across topics: timed, autosaved, with per-question feedback and regrading. Upload past exams and **Match my past exams** writes new ones in their style (question mix, points, phrasing, conventions); the topics those exams test are flagged.
5. **Plan to your exam date.** Give the date and your daily minutes and Margins lays out each day: new topics in prerequisite order, a quiz the next day, spaced reviews, a mock exam after each unit and two full mocks before the exam. Mastery comes from quizzes, exams, voice and practice; **Retry what you missed** and **Fresh review** target weak spots.
6. **Ask your materials**: a chat that answers from your files with numbered citations, and says so when the files don't cover the question.

| | |
|---|---|
| <img src="frontend/public/screens/topics-edit-light-960.webp" alt="The course plan: units and topics, each tied to the file and pages it is taught from"> | <img src="frontend/public/screens/notes-detail-light-960.webp" alt="Topic notes with code, an outline and the source files and pages"> |
| <img src="frontend/public/screens/practice-light-960.webp" alt="Interactive practice problem, one step at a time"> | <img src="frontend/public/screens/exam-light-960.webp" alt="A timed mock exam with its question navigator"> |
| <img src="frontend/public/screens/exam-new-light-960.webp" alt="New mock exam with Match my past exams ticked"> | <img src="frontend/public/screens/ask-light-960.webp" alt="Ask your materials, with a citation open"> |
| <img src="frontend/public/screens/quiz-results-light-960.webp" alt="Quiz results with the right answer, an explanation and the source page"> | <img src="frontend/public/screens/plan-exam-day-light-960.webp" alt="The last days of a plan: a final review, then exam day"> |

Every image here and on [the landing page](https://studymargins.com) comes from the real app, with a hand-written showcase course, in light and dark. `npm run screens` in `frontend/` refreshes them (see [Screenshots](#screenshots)).

## How it works

```
Browser ──▶ Next.js 16 (web) ──────────────▶ FastAPI (ai) ──▶ Claude (Anthropic API)
            UI, auth, API routes,             parsing, chunking,
            jobs, voice turn loop             embeddings, generation, grading
                 │                                  │
                 └──────────▶ Postgres + pgvector ◀─┘        S3-compatible bucket (uploads)
```

- **Parsing and chunking.** Files are read as markdown (PDFs with pymupdf4llm; DOCX, PPTX, and DOC through LibreOffice when installed) and split at headings and paragraphs into chunks of about 350 tokens, each tagged with its heading path and pages.
- **Local embeddings.** Chunks are embedded in-process with `BAAI/bge-small-en-v1.5` (384 dimensions, no API cost) and stored in pgvector with an HNSW index.
- **Topic-scoped retrieval.** Each topic is mapped to at most 24 chunks by hybrid search: vector similarity and Postgres full-text search, merged with Reciprocal Rank Fusion, with a similarity floor so a barely covered topic gets a short list instead of loose matches. Generators only ever see those chunks, so prompt size stays flat as a course grows, and the shared excerpt block is prompt-cached across notes, examples, quizzes and exams.
- **Models.** Claude Opus writes notes, examples, quizzes and exams, plans each course in one low-effort call and answers Ask questions; Claude Haiku handles file validation, short-answer grading and the voice coach.
- **Voice without a speech API.** The browser does speech-to-text and text-to-speech (Web Speech API). The server runs Claude with drill tools (next question, record answer, hint) and streams each turn back as NDJSON.
- **Jobs.** Long tasks run as jobs that are claimed with one atomic update and hold a lease; a reaper re-dispatches jobs whose worker died. Each job records its tokens and cost; a per-user daily budget and a site-wide daily cap bound spend.
- **Isolation.** Only the web service can call the AI service (shared internal token), which is reachable only on Railway's private network.

## Evals

### Retrieval

Everything a topic teaches comes from its 24 mapped chunks, so the mapping is measured. [`evals/`](evals/README.md) holds a retrieval eval over 38 topics in three OpenStax textbook chapters (CS, biology, psychology; about 300 chunks), using the app's real chunker, embedder and search. It needs no API key and runs in under a minute.

| Retrieval (macro average, K = 24) | recall@24 | MRR | nDCG@24 | hit@5 |
|---|---|---|---|---|
| Before: keyword `ILIKE` + vector, flat keyword score | 0.935 | 0.830 | 0.777 | 0.895 |
| Now: vector + full-text, Reciprocal Rank Fusion | **0.989** | **0.961** | **0.932** | **1.000** |

Full results are in [`evals/results/`](evals/results/).

### Generation

The [generation eval](evals/README.md#generation-eval) runs the app's own generators (notes, worked examples, practice problems, quizzes) on two real MIT OpenCourseWare courses, 18.05 (probability and statistics) and 6.006 (algorithms), then checks the output with code and grades it with an Opus judge that does not know which model wrote it. It makes paid API calls behind a spend cap.

| Latest run ([2026-10-21](evals/results/2026-10-21-structure.md), 8 topics, Opus) | |
|---|---|
| Correctness (judge, out of 5) | 4.88 |
| Grounding in the source pages | 4.91 |
| Teaching quality | 4.78 |
| Quiz question quality | 4.50 |
| Quiz questions that restate a worked example | 12% (4 of 32) |
| Cost per topic (all four types) | $0.585 |

It also picked the model: [Sonnet and Haiku made maths errors and fell short of the bar set before the run](evals/results/2026-10-21-model-decision.md), so generation stays on Opus and cost is held down by generating each topic only when it is opened.

## Screenshots

The product screenshots on the landing page, on the sign-in and sign-up pages and in this README are generated from the running app, so they never show an old navigation. [`frontend/scripts/capture-screens.ts`](frontend/scripts/capture-screens.ts) seeds a showcase student and course (written by hand in [`frontend/scripts/screens/`](frontend/scripts/screens/), no model output), signs in, and captures each screen in light and dark as WebP into `frontend/public/screens/`, with phone-sized crops for the landing page.

```bash
# a migrated database and the e2e stack (scripts/e2e-stack.sh start), then:
cd frontend
DATABASE_URL=postgresql://... PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run screens
npm run screens -- --only plan,ask      # a few screens
npm run screens -- --no-seed            # reuse the showcase account already in the database
```

It only runs against a local web app and a local database (the showcase password is public), and needs no AI calls: nothing is generated while it runs.

## Run it locally

You need Node 24+, Python 3.13+ with [uv](https://docs.astral.sh/uv/), Postgres 15+ with pgvector 0.5+, and an [Anthropic API key](https://console.anthropic.com/settings/keys). Set `LLM_PROVIDER=mock` in the AI service to run everything without API calls.

```bash
git clone https://github.com/harishm17/margins.git
cd margins
cp .env.example .env            # add ANTHROPIC_API_KEY and AI_INTERNAL_TOKEN
docker compose up --build       # Postgres, web on :3000, ai on :8000

cd frontend && npm install && npx prisma migrate deploy
```

<details>
<summary>Without Docker</summary>

```bash
# Database
createdb margins && psql margins -c 'CREATE EXTENSION vector;'

# Web
cd frontend && cp .env.example .env && npm install && npx prisma migrate deploy && npm run dev

# AI service
cd ai-service && cp .env.example .env && uv sync && uv run uvicorn app.main:app --reload
```

</details>

<details>
<summary>Environment variables</summary>

Required:

```env
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@localhost:5432/margins
NEXTAUTH_SECRET=...              # openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000
AI_SERVICE_URL=http://localhost:8000
AI_INTERNAL_TOKEN=...            # openssl rand -hex 32, same value in both services
```

Optional:

```env
GOOGLE_OAUTH_CLIENT_ID=...       # Google sign-in
GOOGLE_OAUTH_CLIENT_SECRET=...
LLM_PROVIDER=anthropic           # or mock
ANTHROPIC_MODEL=claude-opus-5-5
ANTHROPIC_FAST_MODEL=claude-haiku-5-5
MODEL_QUIZ=claude-sonnet-5-5:medium  # one model per purpose ("<model>:<effort>"): MODEL_NOTES, _EXAMPLES,
                                     # _PRACTICE, _QUIZ, _EXAM, _GRADING, _TOPICS, _CHAT, _VOICE, _VALIDATION
LLM_MAX_CONCURRENCY=4            # model calls at once in the AI service
VOICE_DAILY_MINUTES=30           # per user per 24 hours
MAX_UPLOAD_MB=25
S3_BUCKET=... S3_ENDPOINT=... S3_REGION=auto S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
```

Without `S3_BUCKET`, uploads go to local disk (Google Cloud Storage also works).

</details>

<details>
<summary>Migrations and re-embedding</summary>

The schema is managed with Prisma migrations in `frontend/prisma/migrations`; after a schema change run `npm run db:migrate -- --name <what_changed>`. A database created earlier with `prisma db push` needs `npx prisma migrate resolve --applied 0_init` once before `migrate deploy`.

Migration `20261022000000_retrieval_indexes` makes embeddings `vector(384)` and clears vectors of any other size. Re-embed afterwards with `uv run python scripts/reembed_chunks.py` (or `--missing-only`) in `ai-service/`.

</details>

## Tests

```bash
cd frontend && npm run lint && npm test && npm run build && npm run test:e2e
cd ai-service && uv run pytest
```

CI (`.github/workflows/ci.yml`) runs Prisma validation, lint, unit tests and a production build for the web app, the pytest suite for the AI service, and the Playwright specs against Postgres with pgvector, the AI service on the mock LLM and the production build (`scripts/e2e-stack.sh` starts the services; run it the same way locally with `DATABASE_URL` set to a migrated database).

## Deployment

Hosted on [Railway](https://railway.com/): the web and AI services, Postgres with pgvector, and a Railway bucket for uploads. The whole project is declared in [`.railway/railway.ts`](.railway/railway.ts), and pushes to `main` deploy automatically. See [docs/deployment/RAILWAY.md](docs/deployment/RAILWAY.md).

## Project layout

```
.railway/railway.ts   Railway project as code
frontend/             Next.js app: pages, API routes, Prisma schema, Playwright e2e
ai-service/           FastAPI service: parsing, embeddings, generation, grading
evals/                retrieval and generation evals, results
docs/                 design spec and deployment guide
```

## License

MIT. See [LICENSE](LICENSE).

Built by [Harish Manoharan](https://harishmanoharan.com) · [GitHub](https://github.com/harishm17) · [LinkedIn](https://linkedin.com/in/harishm17)
