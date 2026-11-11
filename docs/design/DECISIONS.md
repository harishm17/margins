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
- **Leak check and word forms (finding 99, flag `LEAK_WORD_FORMS_TO_JUDGE`, off by default):** `string_leak` says how it matched. A numeral or the exact answer text is a hard leak and always blocks. A match that exists only because a number word stands for a numeral ("two" for 2) is a word-form match. With the flag on, a word-form match alone goes to the caller's own judge (generation hints to `judge_leak`, the reader tutor to its judge); with it off it blocks as before. The practice tutor's strict `_hint_leaks` is unchanged.
- **Support check refill (finding 102, flag `SUPPORT_REFILL`, off by default):** when the support check drops items so a warm-up, quiz, exam topic, review batch or example set is under its floor, the missing items are regenerated once, inside the same billing scope. A set still short is served with what it has and the job result carries `refilled` and `short_by`; a set under the floor (warm-up minimum 3) still fails.
- **Re-quoting (F0, flag `CLAIM_REQUOTE`, off by default):** the `requote_concepts` job (`POST /jobs/requote-concepts`, data `{topicId, projectId}`) gives an active concept with no claims new claims from the topic's remaining files, keeping its id. The quotes are validated like an extraction's. Flag off, the job completes at once, without the topic lock, the AI-ready check or a model call. Flag on, a job that cannot run for an AI outage or the allowance waits for the AI like generation does, and a job that finishes while a later delete orphaned more concepts starts one follow-up for them (concepts it tried and could not quote are not retried). `ai-service/scripts/requote_lost_claims.py` repairs concepts already in that state (estimate first; `--yes` to spend; `--write` to store).
- **Typed PDF pages (finding 104):** when the markdown read of a page holds under half the alphanumerics of its text layer, the text layer is used, for the validator and the chunker alike. `ai-service/scripts/list_text_layer_pages.py` lists affected files and writes nothing; existing chunks are not re-read.

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

## Rulings made while fixing the prompt and voice review findings (2026-11-10)

The reviews of the prompt audit (PR #90) listed bugs and prompt changes. Where a fix changed what a student or an operator would notice, or two findings pulled apart, the call made is recorded here. "v1" is the prompts in production; "v2" is the audited prompts behind `PROMPTS_V2`, off by default. Nothing here was measured against a model: the eval runs that would check the prompt changes are listed in the PR and wait for approval.

**Voice session and turns (both prompt revisions)**

- **The daily cap and the one-live-session rule are checked on every turn,** not only the first. A refusal in the middle of a call ends the call into its summary with the limit shown. Alternative: let the running call finish. Rejected because a student with one minute left could talk for an hour.
- **Ending a call ends it at once,** and a heartbeat does not bring back a call that is closed or has gone quiet. It used to count as live, and use minutes, for 90 seconds more.
- **A reply the student talks over is kept,** marked as cut off, so the note about what the student heard lands on that reply. Before, nothing was stored and the note was written on the reply before it.
- **A turn's claim on the session is a lease that the running turn renews** (every 10 s; stale after 45 s, where it was a flat three minutes). The browser waits 50 s for a busy session and drops a reply stream that has sent nothing for 35 s. The numbers are judgment, not measured: a turn that is slow but alive keeps its claim, and a dead one blocks the next turn for under a minute.
- **A cloud speech stream that does not open in 6 s is given up on** and the browser's own recognizer takes over.
- **A cloud speech stream is closed when the granted voice time runs out.** The browser enforces this; a student who changes the page's code can keep a stream open until the next turn is refused. A hard limit needs the audio to pass through our server, which was not built.
- **Screen readers hear each coach reply once:** the transcript is no longer a live region, and finished replies are announced only when the app is not reading them aloud.
- **Speech text:** "pp. 12" and similar are not sentence ends; multi-line display maths is one unit; I/O and A/B are read as letters; a link is read by its words and a bare address by its site; `*`, `#` and `_` survive when they are part of the text (C#, #1, snake_case).

**Oral quiz and Quiz me**

- **The server decides which question an answer belongs to** (v1). The model's `question_index` is ignored when the server knows the question. Cost if wrong: none seen; the model could only disagree by being wrong.
- **Evidence is written by whichever recording succeeds,** once. A recording that failed after its attempt row was inserted used to lose the evidence for good.
- **The bookkeeping after a recorded answer runs after the coach's feedback starts,** and the turn waits for it before it ends. A failure there is logged and does not stop the reply.
- **A failed question generation is an error the student can retry (503),** not "this topic has no quiz". A sprint goes on with the other topics.
- **`GET /api/voice/drill-pack` is rate limited and answers 404 for a topic outside the course named.**
- **A percentage counts as working only when it is taken of a number** ("15% of 240"). "Why is a 95% interval wider?" is a concept question again. Some questions with light arithmetic now reach the voice drill.

**Teach it back and guided reading**

- **The result that closes an idea carries the next idea** (`next_idea`), so the coach wraps up once and asks the next idea in the same reply. The v1 prompt rule and tool descriptions changed with it and shipped without an eval run; the teach-back eval now plays this and gates it.
- **A new example that held reports nothing as missed.**
- **An unclear answer gets one clarifying question,** then the coach explains or moves on (teach-back and guided reading). It could loop without limit.
- **Guided reading: `next_claim` with no argument while a prediction is waiting skips the prediction when the student has said something;** the claim told is found by its id, not its position.
- **v2 only: the second time a student asks to be told, the server answers with the explanation.** The count reads English phrases in short utterances (14 words or fewer); a student asking in another language is not counted and gets the earlier behaviour.
- **v2 only: a request to be told while a say-back is waiting explains the same claim again and is not scored.**
- **v2 only: a reply cut at the token limit stays said and is finished in the next reply,** not said again from the start.
- **v2 only: the session's first tool runs before the model is called,** so the first reply does not spend a round trip asking for it.
- **v2 only: each kind of turn has a length** (about forty words for a question, sixty for an explanation with its request to say it back, forty for a new example, fifty for a closing turn) and the confront example asks one question. The v1 prompt still models a double question and is expected to fail the new `question_form` gate.
- **v2 only: the grader's note on a wrong idea is tagged as the grader's** (`<grader_note>`), so the coach does not read it as the student's words.

**Practice tutor (both revisions)**

- **Rung 5 goes only with the worked-analogue move;** any other move is held to rung 4 even after a worked example was shown.

**Grading**

- **v2: a key point is met "in any wording or by an equivalent valid method",** for the short-answer grader and the recall grader alike, and generated key points name ideas, not one method. A student who solves it another valid way is no longer marked down. Cost if wrong: more lenient marks; the A5 run measures both kinds of wrong mark.
- **A5 gates:** short answers fail above 3% wrongly passed or 3% wrongly failed; recall above 6% and 12%. A failed gate exits 1. The lines are a first setting from the stored runs, not a studied threshold.
- **The v2 short-answer schema without key points has no `key_point_checks` field** (the branch that scored from it could not be reached).
- **Not done: grading short answers on the recall-grading model as a fallback.** The review offered it as an option; it changes cost and marks and needs its own eval.

**Support check and quotes (both revisions, no flag)**

- **One quote matcher for every quote-in-source check,** which reads past PDF markdown (`**`, `_x_`, `<sup>`) and maths italics, and a citation may name any excerpt the check was shown. 39 of 44 items dropped in the stored v2 run were supported and lost to this. Cost if wrong: a quote that matches only after normalising is accepted where it was dropped; the rule still needs the words in order.

**Generation (v2 unless said)**

- **Rules about the course map are said after `<course_map>`;** inside the tag the lines only name what they list. The same for the gap explainer, recall grader, reader and practice tutor notes.
- **A topic whose later sources did not fit the budget says so above the excerpts.**
- **`difficulty` is hidden from the model in the quiz, exam, review and example schemas** (the app sets it), and `source_excerpts` comes right after the question.
- **A hard warm-up question is one mix-up resisted, still one idea.**
- **A refill's list of questions already written is tagged data** (`written_questions`). On v1 the empty "Do not repeat" header is no longer sent when there is nothing to list.
- **`<diagnosis>` stays as a tag** and is registered with the others.
- **The leak judge for generated examples follows the generation flag,** not the tutor flag.
- **Not changed: the voice drill's key-point generator,** which is not under the grading wording.

**Caching (both revisions)**

- **The practice tutor's and recall grader's system prompts are cached,** and review batches cache the excerpts from the first batch when there is more than one.
- **Not done: caching the refill's excerpts.** A refill is one call per topic and seldom repeats inside the cache's lifetime, so the write would cost more than it saves.

**Operations**

- **`PROMPTS_V2` naming an unknown area stops both services at start.** A misspelt area was ignored silently. Cost: a typo in a deploy fails the health check and the old version keeps serving, which is the point.

**Evals**

- **A2 judge: a fault counts only with its note.** Faults without one are reported apart. Judge counts from earlier runs are not comparable; replayed, the stored v2 run has 2 checkable flags, not 8.
- **Teach-back eval: 29 scenarios, three of them sessions of two ideas.** Earlier numbers are over 26 scenarios.
- **`question_form` gate (95% of turns that ask for the student's thinking):** a question joined to a second one, including "…, and why?", or one that names its answers, fails. It reads wording only. Probes answerable with yes or no are reported, not gated. On the stored runs v1 scores 80% and v2 (before its wording fix) 72%.
- **`wrap_up` gate (95% of closing turns):** 60 words or fewer (the prompt asks for about fifty), the next idea not fetched twice, the next idea asked, nothing asked after the last.
- **The judge reads a closing turn that opens the next idea against the next idea's claims.** Claims of an idea already finished are no longer leaks.
- **The eval keeps the conversation as the app does** (no thinking blocks, the app's trimming limits, which the prompt fixtures carry).
- **`--grader` runs the app's recall grader beside the script and reports agreement;** it does not gate and does not steer the conversation. Claims are sent without a source quote.
- **Not simulated:** interruptions and turn retries (the app's own tests cover them).
- **Tests that only read prompt wording or the mock provider were removed** from the test files PR #90 added.

## Prompt areas switched on (2026-11-10)

`PROMPTS_V2` is set to `generation,support,tutor,ask` for both services in `.railway/railway.ts`. The rule was that an area goes on when its eval re-run is no worse than the v1 baseline (`evals/results/`, the `2026-11-10-*` runs).

- **generation, support: on.** On 10 topics the support check dropped 2 to 4% of items on v2 (8 to 22% on v1), no item was malformed, and the Opus judge flagged 1 of 304 stored questions (7 of 280 on v1).
- **ask: on.** Answers cited the gold passage in 71% of questions (68% on v1) and any passage in 91% (86%), with no errors and no cut-off answers.
- **tutor: on.** The recall grader gave no false credit (0 of 39; v1 1 of 39) and caught 9 of 9 incorrect claims (v1 5 of 9); the reader tutor passed the same gates on both. The practice tutor is level with v1 within one reply (34 and 35 of 38 end with a question or a step, no leak reached the student on either), and wrote 8 of 38 replies twice after the leak check where v1 wrote 4. Cost of the choice: those rewrites add a few seconds to some practice replies. It is accepted for the grader's gain, and the count is re-read in the next tutor eval.
- **voice: off.** v2 fails five gates of the teach-back eval; v1 fails one (the form of its questions). The plan for voice replies is in "Pipeline redesign" below.
- **grading: off.** On 72 wrong answers Haiku marked 3 right on v2 and Sonnet 2; the set is too small to tell them apart, so it grows before either is chosen.
- **ingest: off** until the extraction check exists.

To undo, remove the area from the list and apply the config; no stored data depends on the revision.

## Pipeline redesign (decided 2026-11-10)

**Basis.** The eval outputs of 2026-11-10, and two stored topics of a real course read in the order a student meets them: warm-up, the source pages with their quick checks, notes, recall, worked examples, practice, quiz. Each piece reads well alone. The faults are between the pieces:

- **Separate calls land on the same cases.** Every generator gets the same pages and never sees what the others wrote. In one topic the same question (why a repeated cheap operation with a rare expensive one is cheap on average) is put to the student in seven places, one everyday scenario is used by the notes, a notes check, a worked example and the quiz, and the quiz's one numerical question is a practice problem again with the same numbers and the same answer. A full score on that quiz shows little.
- **Coverage follows nothing.** That topic has 19 claims. Some are asked five to seven times; others are never asked.
- **The chain is serial.** A topic's six jobs run one after another: the quiz is ready about 6.5 minutes after the topic is opened, and the notes (the best-written piece, on a side tab) hold up everything behind them.
- **The exam writes everything new:** 71 questions to keep 40, about 145 s.
- **The voice coach authors with the smallest model.** On the audited prompts it fails five gates; its reply restates what the grader already said, and a voice quiz reads a four-option written question aloud.

**Decisions.**

1. **One list.** A topic's claims are what is taught, practised, tested and graded. Everything generated names the claims it covers, and coverage is counted per claim.
2. **Write once, select many.** One item bank per topic. Warm-up, quiz, review, exam, voice and every check question draw items the student has not seen. D8 stands: no item table. The bank is a `topic_quizzes` kind, and the seen set comes from the evidence rows' `itemKey`.
3. **A topic sheet first, and it hands out the cases.** One call writes the concepts, the claims with their quotes, a line for each claim that can be said aloud, two or three misconceptions per concept, and three example plans. It also gives each lane its own cases: notes, worked examples, practice and the bank get different scenarios and different numbers. The same kind of task with new numbers is practice and is allowed; the same instance twice is a defect the gate rejects.
4. **Lanes run side by side after the sheet:** notes (streamed), examples (worked and practice from the same plans), and the bank (one small call per concept). Notes hold up nothing.
5. **One gate for every item:** the free rules, then a solve without the key. This takes in the support check.
6. **Small models speak, they do not author.** In voice, a graded turn's reply is put together by the app from the grader's result and stored lines. The coach model runs only when the student says something that is not an answer. Voice questions are bank items written to be heard. It is built in the eval harness first and goes on only if it passes every gate v1 passes and the question-form gate v1 fails.
7. **The exam draws from the bank's reserve** (items held back from warm-up, quiz and review) and writes only what is short.
8. **Reading stays the student's own pages.** The source is the main reading step; the notes stay beside it. Because claims quote the source text, the reading fix is measured before the bank is, so the bank's numbers are not taken on text that is about to change.

**What stands.** D2 (the concept is the unit of memory), D8, D9 (a topic is prepared when it is opened), D12 (the app picks the move, the model writes the words; decision 6 extends it) and the scheduler.

**Order.** Voice replies in the eval harness; the reading fix; the topic sheet and the gate, logging only; the bank for one topic beside the old sets and the defect eval on it; then serving, first warm-up and quiz, then review, exam and voice; the lanes side by side; last the learner brief. Each step ships behind a flag that is off.

**Cost if wrong.** The bank could make sessions feel samey if it is too small; the defect eval counts distinct cases per concept before any serving goes on. Assembled voice replies could sound stiff; the eval's transcript read decides, and the coach model stays as the fallback. Nothing stored today is rewritten: the old sets stay until the bank has served a topic end to end.

### Redesign step 1: voice replies built by the app (flag `VOICE_GRADER_LED`, off by default)

Set `VOICE_GRADER_LED=true` on the web service and a graded teach-back turn is answered with a reply the app builds (`frontend/src/lib/voice/assembled-reply.ts`), with no coach-model call for that turn. The grader call is unchanged, so the wait after the student stops speaking loses the coach's time to first sentence and nothing else changes in what is stored.

- **Built by the app:** the explanation of a claim and the say-back request (both `explain` and `explain_first`); the closing turn with the next idea's prompt; a first probe on a missing prerequisite, on a claim stated without its support, on a loose claim, and on a missing claim when the grader's pointer holds one question of 30 words or fewer.
- **Still worded by the coach model:** a probe on a wrong claim, every second probe, the new example, and any turn where the grader gave no usable question, the student's quote is over 16 words or the claim is over 60. So does every turn that is not an answer (a request, a question, small talk).
- **Rules the builder keeps:** a probe never contains the claim's text; only a passed example or every claim covered is called right; the next idea is asked in the closing turn, once.

**Evidence so far (no model run).** The eval's Python mirror (`evals/tutoring/teach_state.py`, `assembled_reply`) is pinned to the TypeScript by two fixtures: `teach_state_parity*.json` (every scenario step) and `assembled_reply_parity.json` (the cases the scenarios do not reach). `run_eval.py --surface teach_back --grader-led` plays the built turns; on the 29 scenarios the app builds 59 of 99 graded turns and those pass every rule-based gate, the question-form gate included (the gate v1 fails at 59%). The other 40 turns are the coach model's and are not measured by a mock run.

**Before it goes on.** The grader writes one spoken probe for each open claim, wrong claims included, so the coach model is left only the second probe and the new example; then one real run with the live grader, read as transcripts. It goes on only if it passes every gate v1 passes and the question-form gate. To undo, unset the variable.
