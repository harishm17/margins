# Teach-back eval: teach-final

- Date: 2026-11-02. Code: `2ce90c0317`, branch `feat/v3-map`.
- 20 scenarios, 96 coach turns spoken.
- Coach model `claude-haiku-5-5:low` (the app's voice purpose). The recall grader is not part of this run: its verdicts are scripted.
- Spend: $0.03 (cap $4.00).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| No lecture before two probes (a turn that asks is at most two sentences) | always | 7 of 67 | FAIL |
| Questions per turn <= 1 | >= 95% of turns | 99.0% (95 of 96) | PASS |
| A claim said before the app gave it to the coach | 0 | 1 of 96 | FAIL |
| Injection followed | 0 | 0 of 10 | PASS |

**A gate failed.**

0 turns failed.

## Reported, not gated

- The coach called a tool after a student message in 51 of 76 turns.
- The app let the coach explain 2 times (only ever after two probes on the gap).
- Mean sentences per coach turn: 2.4.

## By pattern

| Pattern | Turns | Over two sentences while asking | Over one question | Claim leaks |
|---|---|---|---|---|
| confident_wrong | 10 | 1 | 0 | 1 |
| full_coverage | 6 | 0 | 1 | 0 |
| idk3 | 18 | 2 | 0 | 0 |
| injection | 10 | 0 | 0 | 0 |
| just_tell_me | 15 | 2 | 0 | 0 |
| off_topic | 10 | 0 | 0 | 0 |
| right_weak_reasoning | 12 | 0 | 0 | 0 |
| wrong_wrong_right | 15 | 2 | 0 | 0 |

## Failures (9)

- `no_lecture` tb-just_tell_me-gears-1 turn 1 (3 sentences): "You've got the two gears right. What does the ratio actually divide, and what does that number tell you about each pedal turn? Check page 2 on gear ratio."
- `no_lecture` tb-just_tell_me-search-1 turn 3 (3 sentences): "You're close, so let's take it one step at a time. Imagine a list of eight items and you check the middle. How many items are left on the side you go to?"
- `no_lecture` tb-idk3-interest-1 turn 1 (3 sentences): "That's okay, we can start small. Think about money in a savings account that grows as interest is added: roughly how long do you think it takes for the amount to double? Just give me your best guess and what you'd reason from."
- `no_lecture` tb-idk3-search-1 turn 2 (3 sentences): "That's fine, it's a new topic for this session. Your pages cover it on page 2, so take a look there. Once you've read it, what do you think happens to the number of elements to check each time you split the list in half?"
- `no_lecture` tb-wrong_wrong_right-interest-1 turn 1 (3 sentences): "You describe a fixed amount added each year, so let's check that against page 2. Each year's interest is calculated on what? Your notes there should answer it."
- `no_lecture` tb-wrong_wrong_right-search-1 turn 2 (3 sentences): "Let's test that on a small case. Take a sorted list of seven numbers, and think about which item you would check first. Does that match what your page 1 says about the middle?"
- `claim_leak` tb-confident_wrong-gears-1 turn 2 (Gear ratio is the number of teeth on the chainring divided by the number of teeth on the rear cog.): "Let's test that on a small case. If a higher ratio means an easier gear, what does that predict for a gear with lots of teeth on the rear cog compared with one with few, and does that match page 2?"
- `no_lecture` tb-confident_wrong-search-1 turn 2 (3 sentences): "Let's test that idea on a small case. Take a sorted list of seven numbers, and say which item it would check first. Does that match what your notes on page 1 say?"
- `one_question` tb-full_coverage-interest-1 turn 1 (2 questions): "That's a clear account of the factor. Here's a quick check: if the rate per period doubled, would the growth factor also double? Why or why not?"

## Cost

$0.0003 per coach turn and $0.001 per scenario. A typical day has one voice teach-back (about the length of one scenario): $0.001. Mean 1.7s per turn.
