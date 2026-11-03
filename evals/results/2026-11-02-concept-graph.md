# Generation eval: concept-graph

- Date: 2026-11-02. Code: `e76d188fef`, branch `feat/v3-map`.
- Corpora and topics generated: mit-18.05 4. Topics came from: the app's course planner.
- Models: sonnet:low. Content types: concepts, warmup.
- Requested per topic: 3 examples of each kind, 10 quiz questions, medium difficulty, comprehensive notes.
- Judge: off.
- Spend: $0.37 generation, $0.10 topic extraction, $0.00 judge; total $0.47 (caps: $3.00 total, $3.00 judge).

## Cost and latency

Cost uses the app's own price table (`usage.py`) on the token counts the API reported. A topic's cost is the sum of the mean cost of each content type, so the 12-topic projection is for one set of all the types generated here, times 12. Latency is wall time of the app's generator call.

| Model | Per topic | Projected, 12 topics | Concepts | Warm-up | Seconds per topic | Total spent |
|---|---|---|---|---|---|---|
| sonnet:low | $0.093 | $1.12 | $0.045 (16s) | $0.049 (24s) | 40s | $0.368 |

Per-type cells are mean cost per generation and, in brackets, mean seconds.

| Model | Calls | Input tokens | Output tokens | Cache write tokens | Cache read tokens |
|---|---|---|---|---|---|
| sonnet:low | 12 | 90,094 | 18,759 | 0 | 0 |

### Failed generations

A failed generation is a result: it is not scored, and its cost is in the total.

- sonnet:low, warmup, 1 topic(s) (mit-18.05/Random variables, pmf and cdf): LLMOutputError: Warm-up had 1 usable questions of 5 requested

## Automatic checks

No model is involved. These are lexical heuristics: they find things worth reading, they do not prove content right or wrong (see the README for what each can miss). Counts are over every topic generated.

| Check | sonnet:low |
|---|---|
| Plain-text fields with `$` or backslash sequences | 0 |
| Fields with unbalanced `$` | 0 |
| Fields with bare currency | 0 |
| MC explanations naming an option letter (any / strict `Option C`, `(B)`) | 0 / 0 of 0 |
| Quiz recall-copy rate (questions whose numbers all come from this model's notes or examples) | n/a (0 of 0) |
| Concept claim quotes found in their chunk (gate: 98% or more) | 100% (52 of 52) PASS |
| Topics with 3-8 concepts | 4/4 (mean 4.8) |
| Topics where every objective has a concept | 4/4 |
| Topics with an acyclic prerequisite graph | 4/4 |
| Items whose concept tags are all valid (gate: 100%) | 100% (13 of 13) PASS |
| Warm-up questions the topic quiz repeats (gate: 0) | n/a (needs warm-up and quiz) |
| Notes with all expected sections | n/a |
| Notes inside the requested word band | n/a (mean n/a words) |
| Notes with 5-8 recap bullets | n/a |
| Worked-example sets with the requested count | n/a |
| Practice sets with the requested count | n/a |
| Quizzes with the requested question count | n/a |
| Grounding proxy (share of notes sentences sharing vocabulary with the excerpts) | n/a |
| Near-duplicate example statements across topics (Jaccard > 0.6) | 0 |

## Judge

The judge was not run.

## Side by side

Topic `mit-18.05/t00-sets-and-counting-principles`. One notes section and two quiz questions per model, as stored (multiple-choice options already shuffled by the app).

### sonnet:low

