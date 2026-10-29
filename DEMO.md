# Margins — Demo Guide

Everything needed to run a live demo or record a video.

---

## Demo Account

Local development only. `frontend/scripts/seed-demo.ts` refuses to run against anything but a local
database (this machine or docker compose), so this account never exists on studymargins.com.

Students sign in with Google. For the demo, start the web app with `ENABLE_TEST_LOGIN=true` (and
`NEXTAUTH_URL` on localhost) and use the test sign-in on `/login` with `demo@example.com`. No password.

---

## Setup (one-time)

```bash
# 1. Start all services
docker compose up --build

# 2. Apply the database schema (run once, from the frontend directory)
cd frontend
npx prisma db push

# 3. Seed demo data (pre-populates a project with topics + content)
npx tsx scripts/seed-demo.ts

# 4. Open the app
# Browser → http://localhost:3000
```

> **Note:** `npx tsx` downloads and runs the TypeScript runner on the fly — no install needed. If it fails, install it first: `npm install -D tsx`.

Re-running the seed script is safe — it deletes the previous demo project before creating a fresh one.

---

## Environment Variables

The `ANTHROPIC_API_KEY` **and** `AI_INTERNAL_TOKEN` must be set in your shell before `docker compose up`:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
export AI_INTERNAL_TOKEN=replace-with-shared-secret
docker compose up --build
```

For the test sign-in, also `export ENABLE_TEST_LOGIN=true` before `docker compose up`.

`OPENAI_API_KEY` is optional: only the Voice Coach (Scene 8) needs it. All other variables are configured in `docker-compose.yml`. Key defaults:

| Variable            | Value                |
|---------------------|----------------------|
| LLM_PROVIDER        | anthropic            |
| ANTHROPIC_MODEL     | claude-opus-5-5      |
| ANTHROPIC_FAST_MODEL | claude-haiku-5-5    |
| EMBEDDING_PROVIDER  | local                |
| OPENAI_REALTIME_MODEL | gpt-realtime-mini  |
| OPENAI_REALTIME_VOICE | marin              |
| OPENAI_TRANSCRIPTION_MODEL | gpt-4o-mini-transcribe |
| ENABLE_PROCESSING   | true                 |
| ENVIRONMENT         | development          |

---

## Demo Walkthrough (Video Script)

### Scene 1 — Login
1. Open `http://localhost:3000`
2. Click **Sign in**
3. In the test sign-in, enter `demo@example.com`
4. Land on the dashboard — the seeded project is visible immediately

### Scene 2 — Project Overview
1. Click **CS101 Final Exam Prep**
2. Show the two uploaded materials (lecture notes + textbook chapter) with "valid" status
3. Show the three extracted topics: Data Structures, Algorithm Analysis, Sorting Algorithms

### Scene 3 — Reading Notes
1. Click **Data Structures**
2. Show the generated notes tab — full markdown with tables and citations
3. Scroll through the content

### Scene 4 — Solved Examples
1. Switch to the **Examples** tab
2. Show the two solved examples with step-by-step solutions
3. Highlight the key-concepts tags

### Scene 5 — Quiz
1. Switch to the **Quiz** tab
2. Answer the 4 questions (mix of multiple-choice and true/false)
3. Show the score and per-question explanations

### Scene 6 — Live Upload (optional, requires ANTHROPIC_API_KEY)
1. Go back to the project dashboard
2. Click **Upload material** and upload any PDF
3. Watch the status change: pending → processing → valid
4. Topics are automatically re-extracted after all materials are chunked
5. Generate new content for a topic and show it appear

### Scene 7 — Sample Exam
1. Click **Generate Exam** from the project page
2. Configure: select all topics, medium difficulty, 10 questions
3. Start the exam, answer a few questions, submit
4. Show the AI-graded results and feedback

### Scene 8 — Voice Coach (Concept-Only)
1. Open a topic page and click **Voice Drill**
2. Connect and answer 2–3 questions
3. Speak over the coach to show barge‑in / interruption
4. Show the concept-only feedback and hints

---

## Architecture at a Glance

```
Browser  →  Next.js (port 3000)  →  FastAPI AI service (port 8000)
                  │                          │
                  ▼                          ▼
           PostgreSQL + pgvector       Anthropic API (+ OpenAI for voice)
           (port 5432)

Shared volume: /data/uploads  (local file storage in dev)
```

### How processing works in development
1. **Upload:** Next.js writes the PDF to `/data/uploads/` (shared Docker volume)
2. **Validate:** AI service reads the PDF from the same volume, parses it with PyMuPDF, and optionally validates content via LLM
3. **Chunk:** PDF is split into semantic sections; embeddings are generated locally in the AI service
4. **Extract topics:** LLM analyzes chunk structure and returns a topic list
5. **Generate content:** For each topic the LLM produces notes, examples, and quiz questions grounded in the relevant chunks

### Disabling processing
Set `ENABLE_PROCESSING=false` in the ai-service environment (docker-compose.yml).
Validation and chunking will be simulated (instant success, zero chunks).
Useful for pure UI development when you don't have an API key. Set `LLM_PROVIDER=mock` to run the full flow with placeholder content and no API calls.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| AI service returns 500 on LLM calls | Missing or invalid API key | Check `ANTHROPIC_API_KEY` env var, or check `/health/dependencies` (`llm_key`) |
| Voice Coach token request returns 503 | No `OPENAI_API_KEY` set | Set `OPENAI_API_KEY`; without it the voice coach is off |
| Chunking job stays at 0% | File not found at `/data/uploads` | Verify `uploads_data` volume is mounted in both services |
| "No relevant chunks found" on content gen | Chunks weren't created | Check chunking job status; ensure `ENABLE_PROCESSING=true` |
| Prisma client errors on seed | Schema not applied | Run `npx prisma db push` first |
| Port already in use | Another instance running | `docker compose down` then `up` again |
