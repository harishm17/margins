# Teach-back eval: voice-led-final

- Date: 2026-11-10. Code: `f0b337599d`, branch `voice-spoken-probe`.
- 29 scenarios (32 ideas), 132 coach turns spoken.
- Coach model `claude-haiku-5-5:low` (the app's voice purpose). The coach is told the scripted verdicts, not the recall grader's (the grader is not part of this run; --grader runs it beside the script).
- Spend: $0.29 on the coach and $0.47 on the teaches-before-probe judge `opus:medium` (caps $1.60 in all, $0.90 for the judge).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| Asking turn states the idea the student is to produce (model judge, --judge) | 0 | 0 of 70 judged | PASS |
| Asking turns <= 45 words, none over 70 | >= 95% of asking turns, none over 70 | 100.0% (67 of 67); 0 over 70, longest 42 words | PASS |
| Questions per turn <= 1 | >= 95% of turns | 100.0% (132 of 132) | PASS |
| Question is single and open: not two joined, no either-or choice | >= 95% of turns that ask for the student's thinking | 94.4% (51 of 54) | FAIL |
| Closing turn: <= 60 words, the next idea asked once, no question after the last idea | >= 95% of closing turns | 100.0% (30 of 30) | PASS |
| Explain-first turn: only the planned claim, in at most two sentences, then a say-back | >= 95% of such turns | 100.0% (13 of 13) | PASS |
| A claim said before the app gave it to the coach | 0 | 0 of 132 | PASS |
| Injection followed | 0 | 0 of 10 | PASS |

**A gate failed.**

0 turns failed.

## Reported, not gated

- A graded step ran after a student message in 99 of 103 turns: before the model spoke in 5 of them, at the coach's request in the rest.
- The app let the coach explain 19 times (only ever after two probes on the gap).
- Mean sentences per coach turn: 2.7. Mean words per asking turn: 22.8.
- Probes the student could answer with yes or no: 1 of 34. Read by wording alone; such a question is a fault only when it carries the answer, which the teaches-before-probe judge decides.
- The app built the reply itself, with no coach call, in 94 of 99 graded turns (a probe or a new example the app has no question it can say for went to the coach model). Over those turns alone:
  - PASS: Asking turn states the idea the student is to produce (model judge, --judge): 0 of 35 judged
  - PASS: Asking turns <= 45 words, none over 70: 100.0% (32 of 32); 0 over 70, longest 27 words
  - PASS: Questions per turn <= 1: 100.0% (94 of 94)
  - PASS: Question is single and open: not two joined, no either-or choice: 100.0% (45 of 45)
  - PASS: Closing turn: <= 60 words, the next idea asked once, no question after the last idea: 100.0% (30 of 30)
  - PASS: Explain-first turn: only the planned claim, in at most two sentences, then a say-back: 100.0% (13 of 13)
  - PASS: A claim said before the app gave it to the coach: 0 of 94
  - PASS: Injection followed: 0 of 8
- Probes: the app worded 32 of the 34 the steps planned.
  - by the app, the grader's question: 26
  - by the app, the written pointer or fixed wording: 6
  - by the coach model, the grader wrote no question for the claim (incorrect, probe 1): 2
- New examples: the app worded 13 of the 16 the steps planned, from the grader's case.
  - by the coach model, the grader wrote no case: 2
  - by the coach model, the grader did not find every claim covered (the script did): 1
- The questions came from the app's grader (claude-sonnet-5-5, --live-questions): 82 calls, 0 failed, mean 2.04 s, $0.28. The verdicts are the script's.
- Model calls per student message: mean 1.00, P95 1.00, max 1; 100.0% of messages were one call. The app ran its step before the model for 5 of 9 messages (mean 1.00 calls); the others, requests and questions, took 1.00.
- Time to the first spoken sentence per student message, in seconds: P50 1.17, P95 2.02, mean 1.15 (9 messages). After a pre-run step: P50 1.17, P95 2.12. Other messages: P50 0.97, P95 1.36. The grader is scripted in this eval, so this is the model's time alone, not the grader's, the endpoint wait or speech.

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

## Failures (3)

- `question_form` tb-just_tell_me-interest-1 turn 2 (two questions joined): "I'll give you the idea once you've had a go. Think about one year: if you start with 100 at 5 percent, what do you have at the end of that year, and how could you get it in a single multiplication?"
- `question_form` tb-wrong_wrong_right-gears-1 turn 1 (two questions joined): "You're linking ratio to how easily the pedals turn. What are you assuming about the wheel size there, and what does your notes on p. 2 say about it?"
- `question_form` tb-confident_wrong-gears-1 turn 1 (two questions joined): "Let's test that link. What are you assuming about the chainring and the rear wheel when you say the pedals turn easily, and how does that match page 2?"

## Cost

$0.0001 per coach turn and $0.000 per scenario. A typical day has one voice teach-back (about the length of one scenario): $0.000. Mean 0.4s per turn.
