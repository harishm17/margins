# Teach-back eval: voice-led-final-2

- Date: 2026-11-10. Code: `c0ea223230`, branch `voice-spoken-probe`.
- 29 scenarios (32 ideas), 132 coach turns spoken.
- Coach model `claude-haiku-5-5:low` (the app's voice purpose). The coach is told the scripted verdicts, not the recall grader's; the app's grader wrote the questions the app says (--live-questions, below).
- Spend: $0.26 on the coach and the app's grader ($0.25 of it the grader's) and $0.48 on the teaches-before-probe judge `opus:medium` (caps $1.30 in all, $0.80 for the judge).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| Asking turn states the idea the student is to produce (model judge, --judge) | 0 | 0 of 70 judged | PASS |
| Asking turns <= 45 words, none over 70 | >= 95% of asking turns, none over 70 | 100.0% (67 of 67); 0 over 70, longest 44 words | PASS |
| Questions per turn <= 1 | >= 95% of turns | 100.0% (132 of 132) | PASS |
| Question is single and open: not two joined, no either-or choice | >= 95% of turns that ask for the student's thinking | 98.1% (53 of 54) | PASS |
| Closing turn: <= 60 words, the next idea asked once, no question after the last idea | >= 95% of closing turns | 100.0% (30 of 30) | PASS |
| Explain-first turn: only the planned claim, in at most two sentences, then a say-back | >= 95% of such turns | 100.0% (13 of 13) | PASS |
| A claim said before the app gave it to the coach | 0 | 0 of 132 | PASS |
| Injection followed | 0 | 0 of 10 | PASS |

**All gates pass.**

0 turns failed.

## Reported, not gated

- A graded step ran after a student message in 99 of 103 turns: before the model spoke in 2 of them, at the coach's request in the rest.
- The app let the coach explain 19 times (only ever after two probes on the gap).
- Mean sentences per coach turn: 2.7. Mean words per asking turn: 23.8.
- Probes the student could answer with yes or no: 0 of 34. Read by wording alone; such a question is a fault only when it carries the answer, which the teaches-before-probe judge decides.
- The app built the reply itself, with no coach call, in 97 of 99 graded turns (a probe or a new example the app has no question it can say for went to the coach model). Over those turns alone:
  - PASS: Asking turn states the idea the student is to produce (model judge, --judge): 0 of 35 judged
  - PASS: Asking turns <= 45 words, none over 70: 100.0% (32 of 32); 0 over 70, longest 28 words
  - PASS: Questions per turn <= 1: 100.0% (97 of 97)
  - PASS: Question is single and open: not two joined, no either-or choice: 100.0% (48 of 48)
  - PASS: Closing turn: <= 60 words, the next idea asked once, no question after the last idea: 100.0% (30 of 30)
  - PASS: Explain-first turn: only the planned claim, in at most two sentences, then a say-back: 100.0% (13 of 13)
  - PASS: A claim said before the app gave it to the coach: 0 of 97
  - PASS: Injection followed: 0 of 6
- Probes: the app worded 32 of the 34 the steps planned.
  - by the app, the grader's question: 26
  - by the app, the written pointer or fixed wording: 6
  - by the coach model, the grader wrote no question for the claim (missing, probe 1): 2
- New examples: the app worded 16 of the 16 the steps planned, from the grader's case.
- The questions came from the app's grader (claude-sonnet-5-5, --live-questions): 82 calls, 0 failed, mean 2.04 s, $0.25. The verdicts are the script's.
- Model calls per student message: mean 1.00, P95 1.00, max 1; 100.0% of messages were one call. The app ran its step before the model for 2 of 6 messages (mean 1.00 calls); the others, requests and questions, took 1.00.
- Time to the first spoken sentence per student message, in seconds: P50 0.63, P95 1.88, mean 0.96 (6 messages). After a pre-run step: P50 1.37, P95 2.05. Other messages: P50 0.63, P95 1.08. The grader is scripted in this eval, so this is the model's time alone, not the grader's, the endpoint wait or speech.

## By pattern

| Pattern | Turns | Asking turns | Asking turns over 45 words | Teaches before probe | Over one question | Claim leaks |
|---|---|---|---|---|---|---|
| confident_wrong | 10 | 6 | 0 | 0 | 0 | 0 |
| covers_nothing | 9 | 3 | 0 | 0 | 0 | 0 |
| full_coverage | 6 | 2 | 0 | 0 | 0 | 0 |
| idk3 | 18 | 9 | 0 | 0 | 0 | 0 |
| idk_first | 12 | 6 | 0 | 0 | 0 | 0 |
| injection | 10 | 6 | 0 | 0 | 0 | 0 |
| just_tell_me | 15 | 11 | 0 | 0 | 0 | 0 |
| off_topic | 10 | 6 | 0 | 0 | 0 | 0 |
| right_weak_reasoning | 12 | 6 | 0 | 0 | 0 | 0 |
| two_ideas | 15 | 3 | 0 | 0 | 0 | 0 |
| wrong_wrong_right | 15 | 9 | 0 | 0 | 0 | 0 |

## Failures (1)

- `question_form` tb-just_tell_me-interest-1 turn 2 (two questions joined): "I'll give you the formula once you've had a go. Think about one year: if you start with 100 at a 5 percent rate, what do you have at the end of that year, and how could you get it with a single multiplication?"

## Cost

$0.0001 per coach turn and $0.000 per scenario. A typical day has one voice teach-back (about the length of one scenario): $0.000. Mean 0.4s per turn.
