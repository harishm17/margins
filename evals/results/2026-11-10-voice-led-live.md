# Teach-back eval: voice-led-live

- Date: 2026-11-10. Code: `2e23ab7efb`, branch `voice-spoken-probe`.
- 29 scenarios (32 ideas), 132 coach turns spoken.
- Coach model `claude-haiku-5-5:low` (the app's voice purpose). The coach is told the scripted verdicts, not the recall grader's (the grader is not part of this run; --grader runs it beside the script).
- Spend: $0.28 on the coach; the teaches-before-probe judge was not run (no --judge) (caps $1.50 in all, $3.00 for the judge).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| Asking turn states the idea the student is to produce (model judge, --judge) | 0 | not run (needs --judge) | not run |
| Asking turns <= 45 words, none over 70 | >= 95% of asking turns, none over 70 | 100.0% (67 of 67); 0 over 70, longest 39 words | PASS |
| Questions per turn <= 1 | >= 95% of turns | 100.0% (132 of 132) | PASS |
| Question is single and open: not two joined, no either-or choice | >= 95% of turns that ask for the student's thinking | 80.0% (44 of 55) | FAIL |
| Closing turn: <= 60 words, the next idea asked once, no question after the last idea | >= 95% of closing turns | 100.0% (30 of 30) | PASS |
| Explain-first turn: only the planned claim, in at most two sentences, then a say-back | >= 95% of such turns | 100.0% (13 of 13) | PASS |
| A claim said before the app gave it to the coach | 0 | 0 of 132 | PASS |
| Injection followed | 0 | 0 of 10 | PASS |

**Not passed: no result for Asking turn states the idea the student is to produce (model judge, --judge) (a gate that did not run, or only partly, does not pass).**

0 turns failed.

## Reported, not gated

- A graded step ran after a student message in 99 of 103 turns: before the model spoke in 20 of them, at the coach's request in the rest.
- The app let the coach explain 19 times (only ever after two probes on the gap).
- Mean sentences per coach turn: 2.5. Mean words per asking turn: 23.7.
- Probes the student could answer with yes or no: 1 of 34. Read by wording alone; such a question is a fault only when it carries the answer, which the teaches-before-probe judge decides.
- The app built the reply itself, with no coach call, in 79 of 99 graded turns (the new example, and a probe the app has no question it can say for, went to the coach model). Over those turns alone:
  - not run: Asking turn states the idea the student is to produce (model judge, --judge): not run (needs --judge)
  - PASS: Asking turns <= 45 words, none over 70: 100.0% (30 of 30); 0 over 70, longest 27 words
  - PASS: Questions per turn <= 1: 100.0% (79 of 79)
  - PASS: Question is single and open: not two joined, no either-or choice: 100.0% (30 of 30)
  - PASS: Closing turn: <= 60 words, the next idea asked once, no question after the last idea: 100.0% (30 of 30)
  - PASS: Explain-first turn: only the planned claim, in at most two sentences, then a say-back: 100.0% (13 of 13)
  - PASS: A claim said before the app gave it to the coach: 0 of 79
  - PASS: Injection followed: 0 of 7
- Probes: the app worded 30 of the 34 the steps planned.
  - by the app, the grader's question: 24
  - by the app, the written pointer or fixed wording: 6
  - by the coach model, the grader wrote no question for the claim (missing, probe 1): 4
- The questions came from the app's grader (claude-sonnet-5-5, --live-questions): 82 calls, 0 failed, mean 1.91 s, $0.27. The verdicts are the script's.
- Model calls per student message: mean 1.00, P95 1.00, max 1; 100.0% of messages were one call. The app ran its step before the model for 20 of 24 messages (mean 1.00 calls); the others, requests and questions, took 1.00.
- Time to the first spoken sentence per student message, in seconds: P50 1.15, P95 1.95, mean 1.16 (24 messages). After a pre-run step: P50 1.15, P95 1.84. Other messages: P50 1.01, P95 1.99. The grader is scripted in this eval, so this is the model's time alone, not the grader's, the endpoint wait or speech.

## By pattern

| Pattern | Turns | Asking turns | Asking turns over 45 words | Teaches before probe | Over one question | Claim leaks |
|---|---|---|---|---|---|---|
| confident_wrong | 10 | 6 | 0 | not run | 0 | 0 |
| covers_nothing | 9 | 3 | 0 | not run | 0 | 0 |
| full_coverage | 6 | 2 | 0 | not run | 0 | 0 |
| idk3 | 18 | 9 | 0 | not run | 0 | 0 |
| idk_first | 12 | 6 | 0 | not run | 0 | 0 |
| injection | 10 | 6 | 0 | not run | 0 | 0 |
| just_tell_me | 15 | 11 | 0 | not run | 0 | 0 |
| off_topic | 10 | 6 | 0 | not run | 0 | 0 |
| right_weak_reasoning | 12 | 6 | 0 | not run | 0 | 0 |
| two_ideas | 15 | 3 | 0 | not run | 0 | 0 |
| wrong_wrong_right | 15 | 9 | 0 | not run | 0 | 0 |

## Failures (11)

- `question_form` tb-just_tell_me-interest-1 turn 4 (two questions joined): "That matches your pages well. Here's a new case: if the factor were 1.1 instead of 1.05, how would the balance after ten years change, and why?"
- `question_form` tb-wrong_wrong_right-gears-1 turn 3 (two questions joined): 'Yes, you tied the ratio to the teeth and to how far the wheel turns per pedal turn. Try this: if the chainring stays the same but you shift to a smaller cog, what happens to the ratio, and how does pedalling feel?'
- `question_form` tb-right_weak_reasoning-gears-1 turn 2 (two questions joined): "Good, you pointed to the wheel turning on your notes. Here's a new case: if you keep the same chainring but move to a bigger rear cog, what happens to the gear, and how does it feel to pedal?"
- `question_form` tb-full_coverage-gears-1 turn 1 (two questions joined): "You explained that clearly, including why a higher ratio feels harder. Here's a new case: if you move to a bigger cog at the back, what happens to the gear ratio, and how does the pedalling feel?"
- `question_form` tb-full_coverage-interest-1 turn 1 (two questions joined): "Nice, you named the factor and tied it to the number of periods. Here's a new case: if a balance grows by a fixed rate each year, what would you expect to happen to its growth over time, and why?"
- `question_form` tb-off_topic-interest-1 turn 3 (two questions joined): "You've tied it to the number of periods in the exponent. Try this: if you put 1,000 in at 5 percent a year, what does the balance look like after three years, and what would you multiply by each year?"
- `question_form` tb-off_topic-search-1 turn 3 (two questions joined): "Yes, that's the key requirement. Suppose the list isn't sorted and you look at the middle item. What can you conclude, and what can't you?"
- `question_form` tb-two_ideas-gears-1 turn 1 (two questions joined): "That's a clear account of how the ratio is built. Here's a new case: if you shift the chain onto a smaller cog at the back, what happens to the ratio, and how does the pedalling feel?"
- `question_form` tb-two_ideas-gears-1 turn 3 (two questions joined): "Good, you tied development back to the gear ratio and the wheel's circumference. Here's a new case: if you keep the same gear but fit bigger wheels, what happens to the development, and why?"
- `question_form` tb-two_ideas-interest-1 turn 1 (two questions joined): 'You covered the key points clearly, including why the factor is one plus the rate. Suppose the rate doubled while the number of periods stayed the same. What would happen to the growth factor, and why?'
- `question_form` tb-two_ideas-search-1 turn 3 (two questions joined): 'Good, you tied the cost to the number of halvings and named the sorted requirement. Here is a small check: if a sorted list doubles from 500 items to 1000 items, roughly how many comparisons does it add in the worst case, and why?'

## Cost

$0.0001 per coach turn and $0.000 per scenario. A typical day has one voice teach-back (about the length of one scenario): $0.000. Mean 0.6s per turn.
