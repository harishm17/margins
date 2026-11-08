# Workflow suite

Whole student journeys, driven through a browser on a real course: sign up, upload, check the topics, study, review, and so on. The AI service replays recorded model answers, so a run is free and gives the same answers every time. The e2e specs in `tests/e2e` cover single features on the mock model in CI; these workflows cover the journeys between them, on real course text, and run on the box.

## Run it

```sh
# Once: the course files (kept out of the repository; see the script's header)
uv run --with python-pptx python -I scripts/workflow-files.py SOURCE_DIR OUT_DIR

# Every run: starts a stack on a fresh database, runs the workflows, prints the report
WF_FILES_DIR=OUT_DIR WF_CASSETTE_DIR=RECORDINGS_DIR scripts/workflows.sh            # all
WF_FILES_DIR=OUT_DIR WF_CASSETTE_DIR=RECORDINGS_DIR scripts/workflows.sh -g WF1     # one
```

The web app is the production build in `frontend/.next`; run `npm run build` after a frontend change.

A request with no recording fails the step that made it. With `WF_RECORD=1` such a request goes to the real model and is recorded, and the runner prints what the new recordings cost. Record after a change to a prompt, a model or the course files. The recordings hold course text, so they stay outside the repository like the files.

## Steps and checks

A workflow's steps are what the student does. A step that fails stops the workflow: the journey is broken.

A check is something the plan wants true of what the student sees, such as one file order on every page, no text cut off, each thing said once, and an honest wait. Checks are soft: the workflow goes on, and each check's result goes to `WF_RESULTS_DIR/<id>.json`. `report.ts` sums them up.

`expected-failures.ts` lists the checks that fail on today's app, each with the plan item that fixes it and the finding it shows. A listed check that fails is expected. A listed check that passes fails the workflow until its line is removed, so a fix is recorded when it lands and cannot quietly regress. An unlisted check that fails fails the workflow.

## Keeping runs the same

Recordings are matched by prompt, so the course has to reach the model the same way every run:

- One student per workflow (`wf1-student@example.com`, etc.), on a database the runner recreates.
- Fixed names: the course is "Introduction to Algorithms" and the files keep their names.
- A batch's uploads reach the server one at a time, in the order chosen (`arriveInOrder` in `harness/course.ts`). The page still shows one batch. Today the AI service lists files by arrival, so a batch arriving in any order changes the topic-finding prompt.
- A step that adds files waits for the work it would race with. For example, WF1 adds the past exam once the topics are found, because an exam added just before topic finding starts may or may not be in its prompt.
- Excerpts with equal scores come back in a random order (finding 92), so the replay provider replays a recording whose prompt has the same lines in another order. Each prompt keeps one recording: the summary after a recording run lists under `duplicates` any recordings that replay as one request (left from before that rule). Keep one of each, or replay picks between them by the run's order and everything after it changes.
- Answer options and exam questions are shuffled by their own text, so a course stores its answers in the same slots on every build. Steps still choose answers by position and read names from the page, never from the course text.
- A new topic can open on Read without its warm-up when preparation ends within a second (finding 94). `openOnWarmup` opens it again and logs a note; it goes when SW9 lands.
- Replies come at once on replay, so the page can move on sooner than it does with the real model; for example, the setup guide folds the upload area. Helpers such as `openUploadArea` open what the next step needs instead of assuming the page waited.

## Workflows

| Id | Journey |
|---|---|
| WF1 | A new course: a batch of lecture notes with a slide deck and a scan, the topics, a past exam, the duplicate dialog, the topic check (rename, merge) and confirm |
| WF2 | The first topic: the warm-up, reading with a quick check and a margin note, recall, practice with help and a worked example, the examples page and a quiz of every question type. After each stage every surface that shows the topic must agree on the next step, progress and minutes; every screen's model text must render and use idea names right; no button may go blank while busy, a waiting Check on a step with options asks to pick one, and a recall check keeps its result when the student opens the next prompt before it lands |
