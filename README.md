<div align="center">

# Margins

**Study from your own course files.**

Upload your lecture notes, textbook chapters and past exams. Margins splits them into topics, then writes notes, worked examples, quizzes and timed practice exams from that material, with sources you can click back to. A voice coach quizzes you out loud.

<!-- draft for Harish -->
Margins asks you to try before it helps. Each topic starts with a few questions you will probably miss, then the reading, then writing what you remember with the book closed. The AI writes the questions, grades the answers, plans your days and gives the smallest hint that unblocks you. It does not hand you the answer first.

**[studymargins.com](https://studymargins.com)**

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Claude](https://img.shields.io/badge/LLM-Claude-D97757)](https://docs.anthropic.com/)

<img src="frontend/public/screens/plan-light-1920.webp" alt="The Margins plan page: Today lists a review, a quiz and a new topic, and each day after it leads to the exam date" width="860">

</div>

## What it does

1. **Upload** PDF, DOCX, PPTX or DOC files: lecture notes, book chapters, sample exams.
2. **Review the course plan** Margins proposes: units (the syllabus's chapters or weeks) of topics, each tied to the pages that teach it, with learning objectives, prerequisites and an estimated time. Rename, merge, move, add or remove topics before anything is generated.
<!-- draft for Harish -->
3. **Study each topic along a path**: Warm-up, Read, Recall, Practice, Quiz. The topic opens on the step Margins thinks you need next, and says why in one sentence. Worked examples, the explainer and voice practice are tools beside the path.
   - **Warm-up**: a few questions before you read. You will miss some. That is the point: it shows what to look for. Nothing here counts toward quiz scores.
   - **Read**: your own pages, with the passages your warm-up pointed to marked "Focus here", margin notes, short check questions between sections, and a link to the original page. Asking the tutor about a passage needs your own attempt first.
   - **Recall**: close the book and write what you remember, one idea at a time or the whole topic. The grader quotes your words back, says what is not right with the page it is from, and points at what you missed without giving the answer. Opening the reading while a recall card is open means that card does not count.
   - **Explainer**: the AI lesson, opened after recall. It covers only the gaps your recall left, written from your pages.
   - **Worked examples**: solved problems where you predict the next step, then see it. The steps fade as you improve.
   - **Practice**: problems you solve one step at a time. Hints come in three kinds (locate, connect, structure) and say what they cost before you open them. A practice tutor can ask about your working. It never gives the answer.
   - **Quiz**: multiple choice, true/false, numerical and short answer. You say how sure you are on each question, and can show your thinking. Scores are computed on the server; short answers are graded by the model with partial credit. Wrong options name the specific mix-up they stand for.
   - **Voice practice**: a spoken session in ten languages with three styles: quiz me, teach it back (you explain an idea and the coach asks about the gaps), and read it with me (predict a claim from your pages, hear it, answer one check).
4. **Take practice exams** across topics: timed, autosaved, with per-question feedback and regrading. Upload past exams and **Match my past exams** writes new ones in their style (question mix, points, phrasing, conventions); the topics those exams test are flagged.
5. **Plan to your exam date.** Give the date and your daily minutes and Margins lays out each day: new topics in prerequisite order, a quiz the next day, spaced reviews, a mock exam after each unit and two full mocks before the exam. Mastery comes from what you answered yourself in quizzes, exams, recall, review, voice and practice, not from reading; **Retry what you missed** and **Fresh review** target weak spots.
6. **Ask your materials**: a chat that answers from your files with numbered citations, and says so when the files don't cover the question.
<!-- draft for Harish -->
   Finding a fact gets a direct, cited answer. Asking to understand an idea first asks what you think, then explains the gap and ends with a check card you answer from memory. Asking for help with a problem of your own never gets the solution: it asks about your attempt, and after a real try you can ask for a worked example with different numbers. While a mock exam is in progress, Ask declines questions that match the exam.
7. **Review in mixed sessions.** The Review page starts a session of up to 12 questions from the ideas that are due across your topics, never two in a row on the same idea. A miss is followed by a fresh question on the same idea, so you are not re-answering the same wording.
8. **See where you stand.** The map shows one unit's ideas and what builds on what, with a state on each (Solid, Getting there, Shaky, Fading, Inferred, Not started). This week's focus names the few ideas worth your time. The progress panel shows only what you answered yourself, how much help you used and how well your confidence matched your results. There are no streaks, points or badges.

<img src="frontend/public/screens/topics-edit-light-1920.webp" alt="The course plan: units and topics, each tied to the file and pages it is taught from" width="860">

*The course plan Margins proposes. Each topic lists the file and pages it is taught from, and you can rename, move, merge or remove topics before anything is written.*

<img src="frontend/public/screens/notes-detail-light-1920.webp" alt="A topic's Read step: the student's own pages, with links to the original" width="860">

*Read: your own pages for one topic, each linked to the original, with margin notes and an explanation of any passage beside them.*

<img src="frontend/public/screens/practice-light-1920.webp" alt="A practice problem solved one step at a time, with a hint that opens after a first try" width="860">

*Practice: a problem broken into steps, each checked as you go, with hints that open after a first try.*

<img src="frontend/public/screens/ask-light-1920.webp" alt="Ask your materials, with a citation open on the page it quotes" width="860">

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
- **Models.** Claude Opus writes notes, examples, quizzes and exams, plans each course in one low-effort call and answers Ask questions; Claude Haiku handles file validation, short-answer grading and the voice coach. <!-- draft for Harish --> The learning features add three more purposes: Sonnet at low effort writes the practice tutor's replies and grades recall answers, and Haiku at low effort routes Ask messages and judges tutor replies for leaks. Each purpose has its own setting (`MODEL_TUTOR`, `MODEL_RECALL_GRADING`, `MODEL_ROUTER`).
- **Streaming speech-to-text from the browser.** The page streams the microphone (16 kHz PCM from an AudioWorklet) straight to Deepgram Nova-3, with AssemblyAI as the fallback and the browser's Web Speech API after that. The server only mints a short-lived token per session, so no API key reaches the page, and passes the course's key terms so technical words come out right. Text-to-speech stays in the browser. The server runs Claude with drill tools (next question, record answer, hint) and streams each turn back as NDJSON.
- **Jobs.** Long tasks run as jobs that are claimed with one atomic update and hold a lease; a reaper re-dispatches jobs whose worker died. Each job records its tokens and cost; a per-user daily allowance and a site-wide daily cap bound spend.
- **AI outages and the daily allowance.** One shared status record (`ai_status`, read at `GET /status/ai`) says whether the AI is available. Out-of-credit, key and configuration errors mark it unavailable at once; rate limits and overloads do so after three in a row. While it is down, the app shows a site-wide notice and turns the AI buttons off with the reason. The daily allowance is checked before a job is created, not after. A failure that can be retried puts the job back to `pending`; `failed` is final. Mock exam answers are always saved, and grading waits for the AI to come back, for up to 7 days. If `OPS_ALERT_WEBHOOK_URL` is set, the owner gets a message when the AI goes down and when it comes back.
- **Account deletion.** Settings has a Delete account button. It stops the account's jobs, deletes its files, then deletes the account and everything made from it. Spend rows are kept without any link to the person, so the site-wide daily cap still holds.
- **Isolation.** Only the web service can call the AI service (shared internal token), which is reachable only on Railway's private network.
- **Storage.** The web app streams each upload through size and file-type checks into an S3-compatible bucket (a Railway bucket in production); the AI service downloads it from there to process it. Without a bucket, both use a local uploads folder.

<!-- draft for Harish -->
## Effort before help

Research on learning keeps finding the same thing: help given before you try does not stick, and students cannot feel the difference. Margins is built around that. The AI plans, writes questions, grades, diagnoses and gives the smallest hint that unblocks you. The student does the generative work first, and the app enforces the order instead of asking nicely.

Every answer, from any screen, goes through one path:

```
 surfaces: warm-up, reader checks, recall, practice, quiz, exam, review, voice, Ask check
        │   each answer is stored with who graded it and how much help it needed
        ▼
 evidence events (append-only, one row per answer) ──replay──▶ concept memory + mastery
        │                                                         │
        │ credit and penalty spread along prerequisite edges      ▼
        ▼                                          next activity · plan · reviews · map · progress
 knowledge graph per topic: concepts, claims quoted from your pages, edges
```

- **Evidence and the learner model.** Each answer becomes an event with an assistance level that the screen decides, never the model. Level 0 is an answer with no help. Levels 1 to 3 cover a hint, a named idea, a revealed answer or a worked example. Only unassisted answers update a concept's memory and mastery. Assisted ones are kept for display and for the "help used" figure. A concept's memory is replayed from its events with FSRS (`ts-fsrs`, pinned, 90% retention, no short-term steps), so the state is a pure function of the log and can be rebuilt at any time. Mastery is a recency-weighted mean of the last five unassisted scores, capped by how many independent sessions back it up, so ten questions in one sitting count once. A pass on one concept spreads a small credit to the concepts it builds on, and a miss shortens the next review of the concepts that depend on it.
- **Knowledge graph.** When a topic is opened, an extraction job turns its pages into 3 to 8 concepts, each with two to five claims that quote the source. Quotes that are not a verbatim substring of the named chunk are dropped, cycles are broken, and edges (needs, covers, easy to mix up with) are kept with a confidence. A second job proposes links between topics of a unit. Suggested links stay suggestions until the student confirms them on the map.
- **Study path.** A pure function reads a topic's state and returns the next activity and a reason: fix a wrong idea first, then warm-up, read, recall, the explainer for recall gaps, a due review, a prerequisite drill, quiz or practice, and finally a stretch task (teach it back, a harder quiz or a mock exam). The topic page, the plan and the Continue card all use it.
- **Tutoring that does not leak.** The practice tutor works up a ladder from "what have you tried" to locating, naming the idea and showing the general form. The server holds the rung, so the model cannot skip ahead. Every reply that has an authored answer goes through a leak check: a string and number match first, then a model judge looks for the answer in any rearranged form, the problem's numbers plugged into a formula, or a worked example that reuses the problem's numbers. A leaking reply is written again once; if it leaks again, the authored hint for that rung is sent instead.
- **Review sessions.** Due concepts are ordered by wrong idea first, then most overdue, then lowest recall. Questions are interleaved across topics, and each concept moves from recall to telling near-twins apart to using the idea in a chain. A miss is followed by a fresh question written for that idea. If the AI is unavailable, only questions graded by rule are served, and one can be skipped for now.
- **Ask with the attempt first.** A small model sorts each message (lookup, logistics, understand, solve, check answer). Each intent has its own prompt. Solve never solves; the worked example button opens only after a real attempt. A check card at the end of an explanation is graded as an item at a lower assistance level. The exam guard compares a message with the questions of any mock exam in progress and declines without calling a model.
- **Voice teach-back.** The coach asks you to explain an idea, then calls the recall grader on what you said. Its verdict decides the next move: a probe about the gap (never an explanation first), a new example to test whether you can use the idea, or a wrap-up. Only after two probes on the same gap does it explain, from your own pages with the page number, and ask you to say it back.
- **Knowledge map and progress honesty.** The map lays out one unit with `@dagrejs/dagre`: prerequisites above what depends on them, state shown by icon and text as well as colour, and a frontier mark on ideas whose prerequisites are solid. A list view shows the same data for screen readers and phones. The progress panel counts only first tries without help, leaves out weeks with fewer than ten, and shows calibration (what you scored when you were Certain, and when you were guessing). Nothing in it can go up without real retrieval.

## Evals

The method and latest results are also on [studymargins.com/evaluation](https://studymargins.com/evaluation).

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

<!-- draft for Harish -->
### Learning checks

The learning features add three checks. Their numbers are pending, and this section stays a placeholder until the runs are in.

- **Tutoring gates** (`evals/tutoring/`). Scripted students, not a model, play conversations against the practice tutor, Ask and the voice teach-back coach. Code checks every reply for answer leaks, one question per turn, length, a clear next step, rung jumps, the worked-example rule, pointing at the first wrong step, and prompt injection. Gates and results: (eval numbers pending).
- **Recall grader.** The grader labels each claim covered, partial, missing or incorrect, and each label must carry a quote that is a substring of the student's answer or it is downgraded. It can decline to grade a short answer. Results against hand labels: (eval numbers pending).
- **Generation checks** (`evals/generation/`). Claim quotes that are substrings of their chunk, 3 to 8 concepts per topic, every objective mapped, an acyclic prerequisite graph, valid concept ids on every item, and warm-up questions not reused in the quiz. Results: (eval numbers pending).

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

Compose applies the database migrations in a one-shot `migrate` service before the web app and the AI service start. Then open http://localhost:3000 and sign in with the test sign-in.

Students sign in with Google only. The `ENABLE_TEST_LOGIN=true` line above turns on a test sign-in on `/login` that takes any `@example.com` address (for example `you@example.com`) with no password; the e2e stack and the screenshot script use it. To use Google instead, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (an OAuth client with `http://localhost:3000/api/auth/callback/google` as a redirect URI). The test sign-in only works while `NEXTAUTH_URL` is on localhost, and the web app refuses to start with it set on any other site or on Railway.

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
GOOGLE_OAUTH_CLIENT_ID=...       # production only: Google sign-in, the only way students sign in (locally the test sign-in replaces it)
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

Give the specs a database of their own (create it once, migrate it, and use it for the stack and the specs). The stack's AI service sends every pending job in its database, so sharing one with `npm test` or a dev server lets their jobs and the shared AI status leak into the specs.

```bash
createdb margins_e2e   # or: psql -c 'create database margins_e2e'
export DATABASE_URL=postgresql://dev:devpass@localhost:5432/margins_e2e
(cd frontend && npx prisma migrate deploy)
export E2E_RUN_DIR=/tmp/e2e-run   # the specs read the stack's uploads from here
(cd frontend && npx playwright install chromium)   # once
scripts/e2e-stack.sh start            # after the build above
(cd frontend && PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test)
scripts/e2e-stack.sh stop
```

CI (`.github/workflows/ci.yml`) runs the same steps: Prisma validation, lint, type check, unit tests and a production build for the web app, the pytest suite for the AI service, and the Playwright specs against Postgres with pgvector.

## Screenshots

The product screenshots on the landing page, on the sign-in page and in this README are generated from the running app, so they never show an old navigation. [`frontend/scripts/capture-screens.ts`](frontend/scripts/capture-screens.ts) seeds a showcase student and course (written by hand in [`frontend/scripts/screens/`](frontend/scripts/screens/), no model output), signs in, and captures each screen in light and dark as WebP into `frontend/public/screens/`, with phone-sized crops for the landing page.

```bash
# a migrated database and the e2e stack (scripts/e2e-stack.sh start), then:
cd frontend
DATABASE_URL=postgresql://... PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run screens
npm run screens -- --only plan,ask      # a few screens
npm run screens -- --no-seed            # reuse the showcase account already in the database
```

It only runs against a local web app and a local database, signs in with the test sign-in (see [Run it locally](#run-it-locally)), and needs no AI calls: nothing is generated while it runs.

## Deployment

Hosted on [Railway](https://railway.com/): the web and AI services, Postgres with pgvector, and a Railway bucket for uploads. The whole project is declared in [`.railway/railway.ts`](.railway/railway.ts), and pushes to `main` deploy automatically. See [docs/deployment/RAILWAY.md](docs/deployment/RAILWAY.md).

## Analytics

Light visit analytics on studymargins.com only: page views, where a visit came from and eight funnel steps (`signup_completed`, `login_completed`, `course_created`, `files_uploaded`, `notes_generated`, `quiz_started`, `exam_started`, `plan_created`), with counts and yes/no flags as the only properties. No clicks, text, replay, page titles or student content. PostHog Cloud (US) is loaded and reached through `/m` on the site's own origin: the proxy is `frontend/src/app/m/[...path]/route.ts` (logic in `frontend/src/lib/analytics/proxy.ts`), the loader is `frontend/public/hm.js`, and `frontend/src/lib/analytics/track.ts` sends the events. It does not run on other hosts, in automated browsers, or after `?notrack=1` (`?notrack=0` undoes that). Next's own trailing-slash redirect is off (`skipTrailingSlashRedirect`) because PostHog posts to `/m/i/v0/e/`; `src/proxy.ts` redirects trailing slashes for every other path.

## Project layout

```
.railway/railway.ts   Railway project as code
frontend/             Next.js app: pages, API routes, Prisma schema, Playwright e2e
ai-service/           FastAPI service: parsing, embeddings, generation, grading
evals/                retrieval and generation evals, results
scripts/              e2e-stack.sh, the stack the Playwright specs run against
docs/                 deployment guide (RAILWAY.md) and old design screenshots (`design/`)
```

## License

MIT. See [LICENSE](LICENSE).

Built by [Harish Manoharan](https://harishmanoharan.com) · [GitHub](https://github.com/harishm17) · [LinkedIn](https://linkedin.com/in/harishm17)
