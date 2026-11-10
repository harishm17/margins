# Margins: design decisions

This is the system design record for Margins. It has an overview of the architecture, then the 22 decisions (D1 to D22) taken for the learning v3 work, each with the choice, the alternatives and the reason. It was written from the v3 design spec (October 30 to November 3, 2026, kept outside this repository) and checked against `main` on November 4, 2026.

Each decision has a **Status** line. "Built as decided" means the code on `main` matches the decision. Anything that changed, or was decided and not built, says so.

## Architecture overview

```
browser ── Next.js (frontend/) ─────────────────────────────── Postgres (pgvector)
            │ routes: quiz-attempts, practice-progress,           ▲   ▲
            │   item-sessions, recall, practice-tutor, chat,      │   │ concepts, claims,
            │   voice turn loop                                   │   │ edges, items JSON
            │ lib/learning: evidence → replay (FSRS, FIRe) ───────┘   │
            │   → concept memory → topic mastery → ReviewSchedule     │
            │   → plan / next-step / next-activity (pure functions)   │
            └── HTTP (shared internal token) ──► ai-service (FastAPI) ┘
                  sync:  /grade/quiz, /grade/recall, /tutor/practice, /tutor/reader,
                         /chat/answer, /chat/exam-guard, /voice/turn
                  jobs:  validate-material, chunk-material, extract-topics, extract-concepts,
                         link-concepts, generate-content (warm-up among them), gap-explainer,
                         generate-review-items, generate-exam, grade-exam, grade-quiz
        uploads: S3-compatible bucket (a Railway bucket in production)
```

- **Two services and two stores.** The web service (Next.js 16) owns the interface, sign-in, API routes, the job queue, the learner model and the voice turn loop. The AI service (FastAPI) owns parsing, chunking, embeddings, generation, grading and the tutor, and is the only caller of the Claude API. Postgres with pgvector holds the data and the vectors. A bucket holds the uploaded files. Only the web service can call the AI service, with a shared token, and the AI service is reachable only on Railway's private network.
- **Who writes what.** The AI service writes the knowledge graph (concepts, claims, edges) and the generated item JSON. The web service writes evidence and everything derived from it. Neither writes the other's tables. The one exception is the write-back of `concept_ids` into stored item JSON, which the AI service does inside `extract_concepts`; that JSON is AI-service content anyway.
- **Files to topics.** An upload is streamed through size and type checks into the bucket. The AI service reads it as markdown, splits it at headings into chunks of about 350 tokens, embeds them in-process with `BAAI/bge-small-en-v1.5` (384 dimensions) and indexes them in pgvector with HNSW. A topic is taught from at most 24 chunks, found by vector search and Postgres full-text search merged with reciprocal rank fusion and a similarity floor.
- **Topics to concepts.** When a topic is first opened, a job extracts 3 to 8 concepts, each with claims that quote the source verbatim, plus edges between concepts. A second job suggests links across the topics of a unit.
- **Answers to schedule.** Every answer from every surface becomes an append-only evidence event with an assistance level. Concept memory is a pure replay of the events (FSRS-6), and mastery, review schedules, the plan, the map and the next activity are computed from it.
- **Models by purpose.** Each purpose has its own setting in `ai-service/app/config.py`. Opus writes notes, examples, quizzes and exams, plans each course and answers Ask. Sonnet at low effort writes practice-tutor replies and grades recall. Haiku at low effort validates files, grades short answers, routes Ask messages, judges tutor replies for leaks and runs the voice coach.
- **Cost and reliability.** Every model call goes through a budget check and a usage ledger. The per-user daily allowance and the site-wide cap are checked before a job is created. Jobs are claimed atomically, hold a lease and are re-dispatched by a reaper. One shared status record says whether the AI is available.
- **Deployment.** Railway, declared in `.railway/railway.ts`. See [docs/deployment/RAILWAY.md](../deployment/RAILWAY.md).

## The decisions

### D1. The learner model lives in Next.js (TypeScript), with one writer: `recordEvidence`

- **Alternatives:** the Python AI service, next to grading; Postgres triggers.
- **Why:** every interaction that produces evidence already ends in a Next route (quiz attempts, practice progress, the confidence route, the voice tools, and the exam apply step that runs on course load). Prisma owns the schema, the consumers (plan, next step, mastery UI) are TypeScript, so FSRS has a single implementation (ts-fsrs) and no cross-language drift. The pure functions test under `node:test` with the rest of `lib/learning`. Triggers would hide logic where tests and replay can't reach it.
- **Cost:** exam evidence lands when the student next loads the course, not at grading time. Nothing reads concept memory in between.
- **Status:** built as decided (`frontend/src/lib/learning/evidence.ts`).

### D2. The unit of memory is the concept, not the item and not the topic

- **Alternatives:** a card per question (Anki style), or the per-topic ladder Margins had before.
- **Why:** items are generated and deliberately varied, so a student rarely sees the same question twice. Per-item cards would repeat questions or never accumulate history. A topic is too coarse: one weak idea in a six-idea topic either drags the whole topic into review or hides in the average. A concept is what a question probes.
- **Known cost:** a fresh variant is a harder test than a repeated card, so FSRS's retrievability is slightly optimistic. Retention stays at 0.9 rather than being tuned down, and the calibration and unassisted-accuracy panels show whether it matters.
- **Status:** built as decided.

### D3. Concept memory is an append-only event log plus a deterministic replay

- **Alternative:** update memory in place on each answer.
- **Why:** regrades, a rejected edge, backfilling history, a fix to grade mapping and a later move to a new FSRS version all become "delete these events, insert those, replay". With in-place updates each needs its own migration and code path. Volume is small: a heavy semester is a few hundred events per concept.
- **Test:** the replay of the full log equals the state built by recording the events one batch at a time (`memory.test.ts`, "replay equals incremental").
- **Status:** built as decided.

### D4. Writes are serialised per (user, concept) with `pg_advisory_xact_lock`, taken in sorted order

- **Alternatives:** optimistic concurrency with a version column and retry; serialisable isolation.
- **Why:** under READ COMMITTED, two concurrent writers can each replay without the other's uncommitted event, and the later commit overwrites the state with an incomplete replay. An advisory lock keyed on `userId:conceptId` closes the gap with no schema change and no retry loop. Sorting the concept ids prevents deadlock. Serialisable isolation would make every quiz submission retry-prone.
- **Status:** built as decided. Topic-level locks are also taken, after the concept locks, in sorted order (`evidence.ts`).

### D5. FSRS-6 through ts-fsrs 5.4.2, default weights, retention 0.9, one review per concept per local day

- **Alternatives:** ts-fsrs 6.0.0 (FSRS-7 by default, released two days before the decision, with a new async API and weights that can't be converted); fitted per-user weights; Margins' own 1/3/7/14 ladder.
- **Why:** FSRS-6 is the benchmarked production default and v6 was two days old. Fitting needs about 1,000 reviews per user, which no student will have. Collapsing to one review per day stops a quiz, a practice set and a review on the same afternoon from tripling stability through FSRS's same-day path. Replay (D3) makes a later FSRS-7 move cheap.
- **Status:** built as decided (`memory.ts`: `request_retention` 0.9, fuzz off, `maximum_interval` 365, short-term steps off).

### D6. No Elo, IRT, BKT or deep knowledge tracing

- **Alternatives:** Elo with uncertainty for ability and item difficulty (in the first draft); BKT per concept.
- **Why:** a project belongs to one student, so a generated item is answered by exactly one person and item difficulty never gathers evidence; an Elo model would be noise dressed as precision. Per-student data is dozens of events, and simple features beat complex tracing models on small data. The chosen measure (recency-weighted unassisted score, capped by evidence, times retrievability) can be explained to a student in one sentence. Difficulty targeting uses the mastery bands.
- **Revisit when:** courses are shared between students, so items get answered by many.
- **Status:** built as decided.

### D7. Warm-ups, review sessions and drills are `ItemSession` rows, never `QuizAttempt`

- **Alternative:** a `kind` column on `QuizAttempt`.
- **Why:** `QuizAttempt` is read for best scores, missed questions, quiz history, legacy mastery and the plan's first-quiz detection. Every reader would need a filter, and missing one would silently put pretest guesses into mastery. A separate table makes the wrong thing impossible instead of discouraged. "Fix it now" questions are real quizzes and stay `QuizAttempt`.
- **Status:** built as decided (`ItemSession.kind` is `warmup`, `review` or `drill`).

### D8. Concept tags live inside the item JSON; there is no item table

- **Alternative:** an `Item` plus `ItemConcept` relational model.
- **Why:** items already live as JSON in four places (quiz sets, practice and example content, exam questions, the voice bank). Evidence events carry `conceptId` directly, so scheduling and mastery never join items. Choosing review items scans one topic's sets, tens of items, in memory. A relational item model is a large migration of every generator and reader for no behaviour a student would notice.
- **Revisit when:** items are shared across students, or cross-course search is needed.
- **Status:** built as decided.

### D9. Generation stays on demand and never blocks the path

- **Alternative:** extract concepts for the whole course at plan confirmation.
- **Why:** bulk generation is what used the daily budget in the previous version ($4.13 for 7 topics). The Read step needs no AI, because it renders chunks, so a student can start a topic the moment they open it. `extract_concepts` and the warm-up run during the first minutes of reading, and if they aren't ready the warm-up is skipped for that topic. The next-topic prefetch also runs `extract_concepts`. Recall needs claims; until they're ready the recall card says it is preparing and polls.
- **Status:** built as decided. Pre-v3 courses get their concepts and an evidence backfill lazily, when a topic is opened.

### D10. The reader renders the extracted chunk text, linked to the original file; no embedded PDF viewer

- **Alternatives:** pdf.js with text-layer anchors; converting DOCX and PPTX to PDF.
- **Why:** chunk text exists for every supported file type, chunk ids are stable anchors for margin notes, claims and "Explain this", and it needs no new infrastructure. pdf.js covers only PDFs and anchors to page coordinates, not to the text the graph references.
- **Cost:** maths and figures in PDFs read better in the original, so every page links to it.
- **Revisit when:** figures matter to the course, through a pdf.js pane beside the reader.
- **Status:** built as decided.

### D11. Grading and tutor turns are synchronous calls; generation stays as jobs

- **Why:** a tutor reply is at most 80 words and a recall grade is one structured call, and both must arrive before the student can continue, so a job and a poll would only add latency. Generation is long and must survive a closed tab, so it stays a job.
- **Latency targets:** tutor reply plus leak check at most 6 s at p50; recall grading at most 10 s with a visible "Reading your answer" state; Ask adds about 1 s for the router call before streaming starts.
- **Not done, on purpose:** streaming tutor replies (80 words don't need it) and running the router in parallel with the answer (the prompt depends on the intent).
- **Status:** built as decided. The latency targets are targets; the 2026-11-02 runs report a mean of 5.6 s per practice-tutor reply.

### D12. Tutor state and rung transitions are server-side and pure; the model writes only the words

- **Alternative:** tell the model the rules and trust it to follow them.
- **Why:** a prompt alone could not sequence the help in the published tutor studies, a client-side rung resets on refresh, and a model told "just tell me" five times slides up the ladder. `nextRung` is a tested pure function. The model is told the rung it may use, and the leak judge checks it stayed there.
- **Status:** built as decided (`frontend/src/lib/tutor/state.ts`).

### D13. The effort-first core works without AI

- **Why:** the AI has been down for days at a time (the shared credit outage of 2026-10-28). With the AI down, the reader and margin notes, practice with authored hint rungs, quizzes and review sessions over existing items (multiple choice, true/false and numeric are graded by rule), the map and the plan all still work. Recall, the explainer, Ask, voice and short-answer grading show the AI-status banner.
- **Since v3.1:** one rule covers the rest: grade now whatever can be graded by rule, hold only what needs the model, never send a student to an activity that needs the model while it is down, and charge help only when it was delivered. Work in progress is a server draft (D22).
- **Status:** built as decided, with the v3.1 rule.

### D14. Threat model: guard against accidental shortcuts, not determined self-cheating

- Answer keys stay on the server for everything graded there: quiz, exam, review, recall and warm-up.
- Practice is checked in the browser for instant feedback, so a student who reads the key in devtools is cheating only themselves. Practice evidence is reported by the client and trusted at that level; its weight in mastery is bounded by everything else.
- The things that must not be bypassed are the ones that fail silently: tutor leaks, and assisted answers counted as unassisted. Those are enforced on the server.
- **Status:** built as decided.

### D15. The map is a secondary view, scoped to one unit, with a list alternative

- **Why:** Khan retired its knowledge map because linear progression worked better, graph views in note apps get the "bunch of dots" complaint, and open-learner-model research favours maps only for overview questions. So linear concept chips on the topic page are the primary view, the map shows what blocks what, every node has an action, and the list view makes it usable with a screen reader.
- **Status:** built as decided (`@dagrejs/dagre` layout, state shown by icon and text). The course sidebar now has a Map entry of its own, which is more prominent than "secondary" suggests; the map is still one unit at a time.

### D16. No feature flag; each workstream ships complete behaviour, and topics switch to v3 as their concepts arrive

- **Alternative:** a `learningVersion` flag per project.
- **Why:** Margins has few users and merging deploys. A flag doubles the test matrix and leaves two products to maintain. The `hasConcepts` switch is already a per-topic migration boundary.
- **Status:** built as decided. There is still no flag system. What exists is a handful of environment settings (for example `CLOUD_SPEECH_PROVIDERS` and `OPS_ALERT_WEBHOOK_URL`) and one source constant, `SHOW_LEARNING_V3_DRAFT`, which keeps an unfinished results section off the evaluation page.

### D17. Limits, budget and data lifecycle follow the existing paths

- Per-user rate limits use `createRateLimiter`: tutor turns 20 a minute, recall grading 10 a minute, "Explain this" 10 a minute.
- Every model call goes through the provider's budget check and usage ledger, so the daily allowance covers the new features with no new code.
- Every new table cascades on user and project deletion, and the account-deletion tests cover the new tables.
- Margin notes and recall answers are the student's own writing, are deleted with the account and are never used in prompts for anyone else. Deleting a file or a topic does not delete them: the note keeps its text and the passage it sat on and is listed as a note from a removed file or topic (rules per pointer: `frontend/src/lib/materials/references.ts`).
- **Status:** built as decided.

### D18. Tutor prompts are gated by the tutoring eval

- **Why:** tutor behaviour regresses silently, and a generic LLM judge disagrees with humans on most tutoring dimensions. So the gates are programmatic metrics over scripted multi-turn students, and a workstream that changes a tutor prompt can't merge without a passing eval report in its PR.
- **Status:** partly met. The gates exist (`evals/tutoring/`) and the practice tutor and Ask pass them in their latest runs of November 2. The latest voice teach-back run fails its "no lecture before two probes" gate (5 of 69 turns). That gate counted sentences and flagged greetings and acknowledgements, and was replaced on November 3 by a judged `teaches_before_probe` check. A full run of the judged check has not been published. See [evals/results/](../../evals/results/).

### D19. One first-try record per item; help after it changes only flags (v3.1)

- **Alternatives:** score each help rung on a sliding scale; keep level 2 for "helped before attempting".
- **Why:** any scale that gives credit for help invites asking first, and level 2 was invisible to the headline figure, so it was the cheapest path. With rungs 2 and up behind an attempt and one record per item, the only cost the student controls is whether they try first, and trying first never loses.
- **Status:** built as decided (`help-policy.ts`).

### D20. Instruction events live in the evidence log, with weight 0 (v3.1)

- **Alternative:** a separate `InstructionView` table.
- **Why:** D3. `needsInstruction` is derived by the same replay as everything else, so a regrade or a deleted session rebuilds it with no extra code. The events are inert for FSRS and the quality score, and every answer-counting reader already filters on `assistance` or `source`.
- **Status:** built as decided.

### D21. Support band from uncapped ability, label from capped mastery (v3.1)

- **Why:** the cap exists so the app never tells a student they know something too early. It should not also hold back a strong student's difficulty for days. Support and claims about knowledge are separate decisions, so they use separate numbers.
- **Status:** built as decided (`band-server.ts`).

### D22. Drafts on the server, `sessionStorage` as a cache (v3.1)

- **Alternative:** `localStorage` only.
- **Why:** students switch between phone and laptop, and the student-journey reviews found answers lost to closed tabs. One table with compare-and-set covers every surface, and the cache keeps typing working offline.
- **Status:** built as decided (`StudyDraft`, with a `version` column for compare-and-set; payloads are capped at 16 KB and expire).

## Related decisions made later

These were taken outside the v3 spec and are recorded so the reasons are public.

- **Google sign-in only (2026-10-28).** Passwords without email can't be recovered, and sign-up had no email verification. Existing password accounts keep their data by linking on a verified Google email. The cost is that a student without a Google account can't sign in.
- **Mock exams longer than the daily time sit alone on their day,** marked as longer; every other day stays within the daily minutes.
- **Cloud speech recognition (2026-11-03).** Deepgram Nova-3 is streamed from the browser with a short-lived token the server mints per session, and the browser's recognizer is the fallback. AssemblyAI is built as an optional second provider and is off by default, because it trains on audio unless a paid account opts out. Speech output stays in the browser. Voice transcripts are deleted after 180 days; evidence events stay.
- **One model call per graded voice utterance (v3.2).** The server runs the grading step itself and gives the result to the coach as data, which cut the first spoken sentence from 2.8 s to about 1.1 s at the median in the baseline measurement.
