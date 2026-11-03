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

For the test sign-in, also `export ENABLE_TEST_LOGIN=true` before `docker compose up`.

The voice coach, the practice tutor, Ask and the recall grader run on the same Claude key; the browser does the speech. On the mock provider they return placeholder text, so the tutoring scenes only show the flow, not real replies. All other variables are configured in `docker-compose.yml`. Key defaults:

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
2. Click **Sign in**
3. In the test sign-in, enter `demo@example.com`
4. Land on the dashboard — the seeded project is visible immediately

### Scene 2 — Project Overview
1. Click **CS101 Final Exam Prep**
2. Show the two uploaded materials (lecture notes + textbook chapter) with "valid" status
3. Show the three extracted topics: Data Structures, Algorithm Analysis, Sorting Algorithms

<!-- draft for Harish -->
### Scene 3 — The Topic Path
1. Click **Data Structures**. The topic opens on its next step, with one sentence saying why
2. If the topic says "Getting this topic ready", wait a moment. Margins is finding the ideas in the topic's pages, and the path needs them
3. Show the path across the top: Warm-up, Read, Recall, Practice, Quiz. Worked examples, the explainer and voice practice sit beside it as tools
4. Show the one-time card, "Margins asks you to try before it helps"

### Scene 4 — Warm-up and Reading
1. Start the **Warm-up**. Answer a question, tap how sure you are, and note that there are no hints
2. See the answers, each with the page to find it on, then **Start reading**
3. In **Read**, point to the passages marked "Focus here" and the "Open the original" link on each page
4. Add a margin note, then use **Explain this passage**: it asks for your own take first (at least 8 characters, or "I can't parse any of it")

### Scene 5 — Recall and the Explainer
1. Go to **Recall**. Write what you remember of one idea with the reading closed
2. Show the feedback: what you got (quoting you), what is not right with its page, and what you missed as a pointer, not as the answer
3. Try the explainer from a fresh topic first to show the gate ("Try recalling first"), then open it after recall. It covers only the gaps

### Scene 5b — Practice and Quiz
1. Open **Practice**. Check an answer, then open **Locate**. Each hint says what it costs before it opens
2. Switch to the **Worked examples** tab and write a guess for the next step before it opens
3. Take the **Quiz**. Tap how sure you are on each question, and expand "Show your thinking" on one
4. In the results, show "You were sure about these", the prediction line and the "About your pick" note on a wrong option

### Scene 6 — Live Upload (optional, requires ANTHROPIC_API_KEY)
1. Go back to the course
2. Open **Materials** and upload any PDF
3. Watch the status change: pending → processing → valid
4. Topics are automatically re-extracted after all materials are chunked
5. Generate new content for a topic and show it appear

### Scene 7 — Sample Exam
1. Click **New mock exam** from the Mock exams page
2. Configure: select all topics, medium difficulty, 10 questions
3. Start the exam, answer a few questions, submit
4. Show the AI-graded results and feedback

### Scene 8 — Review Session, Ask and the Map
<!-- draft for Harish -->
1. Open **Review** and click **Start today's review**. Answer a question and note that a miss is followed by a fresh question on the same idea
2. Open the **Progress** panel on the Review page. It counts only your own first tries and shows how your confidence matched your scores
3. Open **Ask** and ask "Explain <an idea>". It asks what you think first, then explains the gap and ends with a check card
4. Paste a practice question and ask for the answer. Note that it asks about your attempt instead. After a real attempt, "Show me a worked example" appears
5. Start a mock exam, then ask Ask one of its questions. It declines and links back to the exam
6. Open **Map**. Choose a unit, select an idea, and show how it connects and what your last answers were. Try **List view**

### Scene 9 — Voice Coach (Teach It Back)
1. Open a topic page and open the **Voice practice** tab
2. Choose **Teach it back**, connect and explain one idea in your own words
3. Show the coach asking about what is missing and not explaining first. Page numbers appear on the board
4. Speak over the coach to show barge-in. Without speech recognition, type instead
5. Show the summary: what you explained, what needed two questions, and one next step
6. Try **Quiz me** and **Read it with me** for the other two styles

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
5. **Find the ideas:** For each topic the LLM returns a few concepts with claims that quote the chunks, and the edges between them
6. **Generate content:** For each topic the LLM produces notes, examples, quiz questions and warm-up questions grounded in the relevant chunks

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
