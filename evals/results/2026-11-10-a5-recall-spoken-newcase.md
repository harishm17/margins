# A5 recall grader (a5-recall-spoken-newcase, 2026-11-10)

43 hand-labelled recall answers (38 gradable, 5 not) to 9 recall prompts, 152 claim labels {'covered': 113, 'partial': 8, 'incorrect': 9, 'missing': 22}, graded once per arm by the app's recall grader (`grade_recall`, prompts v2, PROMPTS_V2='generation,support,tutor,ask'). The requests are the voice coach's (`spoken`): the grader also writes the question to ask aloud.

- **app**: claude-sonnet-5-5 at low effort; 43 graded, 0 errors; $0.129

## Scores

| Score | app |
|---|---|
| Verdict agrees with the label (per claim) | 95% (144 of 152) |
| Answers with every claim right | 82% (31 of 38) |
| Claims not covered that were marked covered (lower is better) | 0% (0 of 39) |
| Covered claims not marked covered (lower is better) | 7% (8 of 113) |
| Ungradable answers flagged (higher is better) | 100% (5 of 5) |
| Gradable answers held back (lower is better) | 0% (0 of 38) |
| Reasoning gap agrees (covered claims with a gap label) | 100% (6 of 6) |

## Gates

Both kinds of wrong mark are gated, so a change cannot buy one with the other.

| Gate | Line | app |
|---|---|---|
| Claims not covered that were marked covered | at most 6% | 0% (0 of 39): pass |
| Covered claims not marked covered | at most 12% | 7% (8 of 113): pass |

All gates pass.

## By answer kind

Per-claim verdict agreement, on answers that were graded.

| Kind | app |
|---|---|
| full | 100% (36 of 36) |
| other_words | 100% (19 of 19) |
| partial | 96% (24 of 25) |
| contradicted | 94% (34 of 36) |
| one_or_more_missing | 92% (22 of 24) |
| reasoning_gap | 75% (9 of 12) |

## Label against verdict

**app**

| Label \ verdict | covered | partial | missing | incorrect | none |
|---|---|---|---|---|---|
| covered | 105 | 8 | 0 | 0 | 0 |
| partial | 0 | 8 | 0 | 0 | 0 |
| missing | 0 | 0 | 22 | 0 | 0 |
| incorrect | 0 | 0 | 0 | 9 | 0 |

## Questions for the voice coach

For each claim the grader left open, what the app can do with the question it wrote, by the reply builder's own rules: one open question, short enough to hold by ear, that does not say the claim (of two questions joined in one sentence it asks the first). Any other outcome goes to the coach model. The questions themselves are in the run's raw folder.

**app**: 96% (45 of 47) said by the app.

| Outcome | partial | missing | incorrect |
|---|---|---|---|
| the app says it (as written, or the first of two joined questions) | 16 | 20 | 9 |
| none from the service (none written, or it said the claim) | 0 | 2 | 0 |
| not one open question | 0 | 0 | 0 |
| says the claim (dropped by the app) | 0 | 0 | 0 |

New example, for the 14 answers the grader found to cover every claim: the app says it: 13; not one open question, or too long: 1.
