# Margins — Demo Guide

Everything needed to run a live demo or record a video.

---

## Demo Credentials

Local development only. `frontend/scripts/seed-demo.ts` refuses to run against anything but a local
database (this machine or docker compose), so this account never exists on studymargins.com.

| Field    | Value                  |
|----------|------------------------|
| Email    | demo@studymargins.com |
| Password | demo1234               |

---

## Setup (one-time)

```bash
# 1. Start all services. Compose applies the database migrations before the app starts.
cp .env.example .env
docker compose up --build

# 2. In a second terminal, seed demo data (pre-populates a project with topics + content)
cd frontend
npm install
DATABASE_URL=postgresql://dev:devpass@localhost:5432/margins npx tsx scripts/seed-demo.ts

# 3. Open the app
# Browser → http://localhost:3000
```

Re-running the seed script is safe — it deletes the previous demo project before creating a fresh one.

---

## Environment Variables

Compose reads `.env` (copied from `.env.example`). It runs on the mock LLM (`LLM_PROVIDER=mock`): placeholder content, no API calls. For the live upload and generation scenes, set a real key in `.env` before `docker compose up`:

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

The voice coach runs on the same Claude key; the browser does the speech. All other variables are configured in `docker-compose.yml`. Key defaults:

| Variable            | Value                |
|---------------------|----------------------|
| LLM_PROVIDER        | mock (in `.env.example`) |
| ANTHROPIC_MODEL     | claude-opus-5-5      |
| ANTHROPIC_FAST_MODEL | claude-haiku-5-5    |
| EMBEDDING_PROVIDER  | local                |
| ENABLE_PROCESSING   | true                 |
| ENVIRONMENT         | development          |

---

## Demo Walkthrough (Video Script)

### Scene 1 — Login
1. Open `http://localhost:3000`
2. Click **Log in**
3. Enter `demo@studymargins.com` / `demo1234`
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
           PostgreSQL + pgvector       Anthropic API (Claude)
           (port 5432)

Shared volume: /data/uploads  (local file storage in dev; production uses an S3 bucket)
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
| Chunking job stays at 0% | File not found at `/data/uploads` | Verify `uploads_data` volume is mounted in both services |
| "No relevant chunks found" on content gen | Chunks weren't created | Check chunking job status; ensure `ENABLE_PROCESSING=true` |
| Prisma client errors on seed | Schema not applied | Check that the `migrate` service finished: `docker compose logs migrate` |
| Port already in use | Another instance running | `docker compose down` then `up` again |
