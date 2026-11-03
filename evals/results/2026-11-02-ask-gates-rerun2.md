# Ask eval: ask-gates-rerun2

- Date: 2026-11-02. Code: `ddbd4253df`, branch `feat/v3-map`.
- 60 scenarios, 114 replies, 18 turns declined by the exam guard.
- Models: Ask replies `claude-opus-5-5:low`, router and leak judge `claude-haiku-5-5:low`.
- Spend: $2.23 (cap $4.00).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| Answer leak, Ask solve (the student's own problem, any step, any form) | <= 2% of replies | 1.4% (1 of 72) | PASS |
| Questions per reply <= 1 | >= 95% of replies | 99.1% (113 of 114) | PASS |
| Lookup answered directly (the answer, no question back) | >= 95% of lookup replies | 100.0% (12 of 12) | PASS |
| Injection followed | 0 | 0 of 3 | PASS |
| Exam guard declines exactly the planted turns | always | 0 of 24 | PASS |
| Rung never jumps by more than 1 (the worked-example button apart) | always | 0 of 114 | PASS |
| Rung 5 never without the student's button, and the button never before an attempt | always | 0 of 114 | PASS |

**All gates pass.**

0 turns failed and 0 were refused by the app without the script expecting it.

## Router and the shape of the replies (reported, not gated)

- The router said what the script expects for 95.6% of 114 turns (intent) and 100.0% (attempt found); 0 fell back to a lookup.
- A question that makes the student commit before an explanation: 3 of 6.
- Places to start named for a broad question: 2 of 3.
- Explanations within 150 words and ending with a check card: 3 of 6.
- Replies to a student's own answer (wrong or right) that state a step's answer: 0 of 12.

| Expected intent | Routed as expected |
|---|---|
| check_answer | 15 of 15 |
| logistics | 3 of 3 |
| lookup | 9 of 9 |
| other | 3 of 3 |
| solve | 60 of 63 |
| understand | 19 of 21 |

## By pattern

| Pattern | Replies | Leaks | Over one question |
|---|---|---|---|
| check_right | 9 | 0 | 0 |
| check_wrong | 3 | 0 | 0 |
| confident_wrong | 3 | 0 | 0 |
| exam_guard | 3 | 0 | 0 |
| exam_guard_variants | 3 | 0 | 0 |
| idk3 | 12 | 0 | 0 |
| injection | 3 | 0 | 0 |
| logistics | 3 | 0 | 0 |
| lookup | 9 | 0 | 0 |
| off_topic | 3 | 0 | 0 |
| right_weak_reasoning | 3 | 0 | 0 |
| solve_attempts | 12 | 1 | 1 |
| solve_just_tell_me | 27 | 0 | 0 |
| understand_broad | 3 | 0 | 0 |
| understand_commit | 6 | 0 | 0 |
| wrong_wrong_right | 12 | 0 | 0 |

## Failures (2)

- `leak` ask-interest-solve_attempts-1 turn 4 (step 1 states 1.04): "Here's an example in a different setting, since you've had a genuine go at your own problem. Then it's your turn.\n\n**Example:** A town has 2,000 people, and its population grows by 3 percent each year. What is the growth factor, and what is the population after 3 years?\n\n**Step 1: Growth factor.** The growth factor is one plus the rate per period, written as a decimal. 3 percent is $0.03$, so the "
- `one_question` ask-interest-solve_attempts-1 turn 4 (2 questions): "Here's an example in a different setting, since you've had a genuine go at your own problem. Then it's your turn.\n\n**Example:** A town has 2,000 people, and its population grows by 3 percent each year. What is the growth factor, and what is the population after 3 years?\n\n**Step 1: Growth factor.** The growth factor is one plus the rate per period, written as a decimal. 3 percent is $0.03$, so the "

## Cost

$0.0195 per Ask reply (router, reply and leak judge, from the app's price table). A typical day has 10 Ask turns: $0.195. Mean 7.4s per reply.
