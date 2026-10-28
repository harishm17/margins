# Model choice for study content (2026-10-21)

Runs: [`2026-10-20-model-choice.md`](2026-10-20-model-choice.md) (Opus, Sonnet, Haiku at medium
effort; MIT 18.05 and 6.006, 4 topics each, all four content types, Opus judge) and
[`2026-10-21-opus-effort.md`](2026-10-21-opus-effort.md) (Opus low vs medium effort). Both ran on the
code before the option-letter fix (PR #21), so the judge's "explanation names the wrong option"
errors are counted against every model; that bug is fixed.

## Rule (set before the run)

Per purpose, the cheapest model whose judge correctness mean is at least 4.5 with no mathematical
error, and whose teaching/question-quality mean is within 0.3 of Opus.

## Result

| Model | Cost per topic (4 types) | Correctness | Teaching | Quiz question quality | Maths errors |
|---|---|---|---|---|---|
| Opus, medium | $0.62 | 4.81 | 4.84 | 4.38 | 0 |
| Sonnet, medium | $0.24 | 4.53 | 3.84 | 3.25 | 6 |
| Haiku, medium | $0.02 | 4.19 | 3.75 | 2.62 | 7 |

Sonnet and Haiku fail the rule for every content type (maths errors in notes, worked examples and
quizzes; teaching about a point below Opus). Opus at low effort costs $0.52 per topic (16% less);
its sample was partial (the run's spend cap stopped generation early) and its teaching mean was
lower (4.00 against 4.62 in the same judging), so it is not adopted.

## Decision

- Notes, worked examples, practice, quizzes and exams stay on `claude-opus-5-5` at medium effort
  (the `MODEL_*` defaults are unchanged).
- Cost is controlled by generating on demand (PR #22: a topic's content is made when the student
  opens it, one type at a time) rather than by a weaker model.
- Per-user daily allowance `DAILY_LLM_BUDGET_USD` rises from 3 to 8: one 8-topic unit fully
  generated (about $5) plus a mock exam and a day of chat, with a little headroom. A global daily
  cap across all users (stage 2) bounds the total, because sign-up is open.

## Findings that apply to every model (fixed in stage 2)

- Practice steps typed multiple choice sometimes came with no options.
- Practice answer keys were fragile: unreduced fractions, formulas checked by string match,
  comma-separated accepted answers.
- Quiz questions reused the notes' and examples' numbers (recall-copy rate 60-87%).
