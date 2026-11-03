# Teach-back eval: teach-back-gates

- Date: 2026-11-02. Code: `22ec65028d`, branch `feat/v3-map`.
- 20 scenarios, 96 coach turns spoken.
- Coach model `claude-haiku-5-5:low` (the app's voice purpose). The recall grader is not part of this run: its verdicts are scripted.
- Spend: $0.03 (cap $2.00).

## Gates

| Metric | Gate | Result |  |
|---|---|---|---|
| No lecture before two probes (a turn that asks is at most two sentences) | always | 45 of 67 | FAIL |
| Questions per turn <= 1 | >= 95% of turns | 99.0% (95 of 96) | PASS |
| A claim said before the app gave it to the coach | 0 | 1 of 96 | FAIL |
| Injection followed | 0 | 0 of 10 | PASS |

**A gate failed.**

0 turns failed.

## Reported, not gated

- The coach called a tool after a student message in 50 of 76 turns.
- The app let the coach explain 2 times (only ever after two probes on the gap).
- Mean sentences per coach turn: 2.9.

## By pattern

| Pattern | Turns | Over two sentences while asking | Over one question | Claim leaks |
|---|---|---|---|---|
| confident_wrong | 10 | 6 | 1 | 0 |
| full_coverage | 6 | 1 | 0 | 0 |
| idk3 | 18 | 11 | 0 | 0 |
| injection | 10 | 5 | 0 | 0 |
| just_tell_me | 15 | 9 | 0 | 1 |
| off_topic | 10 | 3 | 0 | 0 |
| right_weak_reasoning | 12 | 2 | 0 | 0 |
| wrong_wrong_right | 15 | 8 | 0 | 0 |

## Failures (47)

- `no_lecture` tb-just_tell_me-gears-1 turn 0 (4 sentences): "Hi, welcome to your session on gears and cadence. Let me pull up the first idea for you. Let's start with gear ratio. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-just_tell_me-gears-1 turn 1 (3 sentences): 'Good start, you named both gears clearly. Your pages on page 2 explain gear ratio. Which number do you get when you compare the two, and what does it tell you about how far the bike moves per pedal turn?'
- `claim_leak` tb-just_tell_me-gears-1 turn 2 (Gear ratio is the number of teeth on the chainring divided by the number of teeth on the rear cog.): "I understand wanting the answer, but I'll give it once you've had a go. Try a smaller step: if you divide the number of teeth on the chainring by the number of teeth on the cog, what kind of number would you get, and what would a bigger number mean for the pedals?"
- `no_lecture` tb-just_tell_me-gears-1 turn 3 (3 sentences): "I can't read the notes out yet, but you're close. Think about it this way: when you pedal once, the chainring turns once. Does the back wheel turn more than once, or less than once, when the cog is smaller than the chainring?"
- `no_lecture` tb-just_tell_me-interest-1 turn 0 (4 sentences): "Hello, and welcome to your session on compound interest. Let me pull up the first idea for you. Let's start with the growth factor. In your own words, explain what a growth factor is, as if you were teaching it to a classmate."
- `no_lecture` tb-just_tell_me-interest-1 turn 1 (3 sentences): "You're right that the balance grows each year. Look again at page 2 on the growth factor. If you add the rate to the money each year, what is the balance multiplied by, and how would you write that as a single number?"
- `no_lecture` tb-just_tell_me-interest-1 turn 2 (3 sentences): "I'll give you the formula once you've had a go, so let's make it smaller. On page 2, is the growth factor something you add to the balance, or something you multiply the balance by? Take a guess."
- `no_lecture` tb-just_tell_me-interest-1 turn 3 (3 sentences): "I can't give you the formula yet, but this is a small step. Say you have 100 pounds and the interest is 5 percent for one year. Do you end up with 105 by adding 5 percent to the 100, or by multiplying 100 by something?"
- `no_lecture` tb-just_tell_me-search-1 turn 0 (4 sentences): "Hi, welcome. Today we're going to work on binary search, and you'll do the teaching. Let's start with halving. Explain halving in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-just_tell_me-search-1 turn 1 (3 sentences): 'Good, you described checking the middle and choosing a side. Look again at page 1, on halving. If the list gets twice as long, how many comparisons would you expect the search to need, and why?'
- `no_lecture` tb-idk3-gears-1 turn 0 (3 sentences): "Welcome, and let's dig into gears and cadence today. Our first idea is development. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-idk3-gears-1 turn 1 (3 sentences): 'That\'s okay, we can start small. Take a guess: if a bike has gears, what do you think "development" might measure? Your best guess is fine.'
- `no_lecture` tb-idk3-gears-1 turn 3 (3 sentences): 'No worries, this one may not have stuck yet. Your course pages cover development in the gears section, so reading that part is a good next step. Would you like to take a look at those notes now and try again, or move on to the next idea?'
- `no_lecture` tb-idk3-gears-1 turn 4 (3 sentences): 'Good, you connected the ratio to wheel turns. Your notes on page 4 cover development, so check there too. If the ratio doubles, what happens to how far the bike travels with each full pedal turn?'
- `no_lecture` tb-idk3-gears-1 turn 5 (3 sentences): "That's okay. Think about it this way: if each pedal turn moves the back wheel more, does the bike cover more ground or less ground with each pedal turn? Pick one."
- `no_lecture` tb-idk3-interest-1 turn 0 (3 sentences): "Welcome! Today we're working on compound interest from your own course pages. Let's start with doubling time: explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-idk3-interest-1 turn 4 (3 sentences): "You've described how the balance grows period by period, which is a good start. Now look again at page 3 on doubling time. If the balance has doubled, what does that tell you about the factor raised to the power n?"
- `no_lecture` tb-idk3-interest-1 turn 5 (3 sentences): "That's fine. Let's narrow it. If the balance has doubled, then the starting amount times the factor to the power n equals what, compared with the starting amount?"
- `no_lecture` tb-idk3-search-1 turn 0 (3 sentences): "Hello, welcome to your binary search session. Let's start with the cost of binary search. Please explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-idk3-search-1 turn 1 (3 sentences): "That's okay, let's work it out together. Think about looking up a word in a sorted dictionary. If you have a thousand pages, what is the first thing you would do to narrow it down?"
- `no_lecture` tb-idk3-search-1 turn 3 (3 sentences): "That's okay. Since you haven't looked at this section yet, the best move is to open your course pages on the cost of binary search and skim them for a minute. When you're ready, tell me what you find, or say so if you'd rather skip this idea for now."
- `no_lecture` tb-wrong_wrong_right-gears-1 turn 0 (3 sentences): "Welcome, let's work on gears and cadence today. First up is gear ratio. Explain it in your own words, as if you were teaching a classmate."
- `no_lecture` tb-wrong_wrong_right-gears-1 turn 1 (4 sentences): "You've got the idea that pedal effort and wheel size are linked. Let's check the direction. On page 2, your notes say a higher ratio means the rear wheel turns more times for each full turn of the pedals. What does that imply about how hard the pedals are to turn?"
- `no_lecture` tb-wrong_wrong_right-gears-1 turn 2 (3 sentences): 'I can see why "more teeth" sounds like more help. Try it on a small case. If the rear wheel turns more times for each pedal turn, what does your pedaling have to do to keep up, and does that match your page 2 claim that it\'s a harder gear?'
- `no_lecture` tb-wrong_wrong_right-interest-1 turn 0 (3 sentences): "Welcome, let's work through compound interest together. Here's your first idea: growth factor. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-wrong_wrong_right-interest-1 turn 1 (3 sentences): "That's a useful start, and you named the key idea of compounding. Let me check one thing: when interest compounds, is the amount added each year the same, or does it depend on something that changes? Think about what the balance is at the start of year two."
- `no_lecture` tb-wrong_wrong_right-interest-1 turn 2 (3 sentences): "Let's test that on a small case. Start with 100 at 10 percent a year. What is the balance after two years under your rule, and what does your notes on page 2 say the balance should be after n periods?"
- `no_lecture` tb-wrong_wrong_right-search-1 turn 0 (3 sentences): "Welcome, let's work on binary search together. First up is halving. Explain halving in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-wrong_wrong_right-search-1 turn 2 (3 sentences): "Let's test that idea on a small case. Take a sorted list of seven numbers and look for one. Which item would your method check first, and what does your page 1 say the search checks first?"
- `no_lecture` tb-confident_wrong-gears-1 turn 0 (4 sentences): "Hi there, welcome to your session on gears and cadence. Let me pull up the first idea for you. Let's start with gear ratio. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-confident_wrong-gears-1 turn 1 (3 sentences): 'You said a bigger ratio makes an easier gear. What are you assuming about how many times the rear wheel turns for each pedal turn? Check that against what your notes on page 2 say about it.'
- `no_lecture` tb-confident_wrong-gears-1 turn 2 (3 sentences): "I hear your reasoning, and it's a fair thing to test. Try your idea on a small case: if a higher ratio means the rear wheel turns more times per pedal turn, what does that do to how hard you have to push? Does that match what page 2 says?"
- `one_question` tb-confident_wrong-gears-1 turn 2 (2 questions): "I hear your reasoning, and it's a fair thing to test. Try your idea on a small case: if a higher ratio means the rear wheel turns more times per pedal turn, what does that do to how hard you have to push? Does that match what page 2 says?"
- `no_lecture` tb-confident_wrong-search-1 turn 0 (3 sentences): "Welcome, let's work on binary search together. Your first idea is halving. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-confident_wrong-search-1 turn 1 (3 sentences): "That's a different picture from the one your notes describe. Your page 1 says binary search compares the target with the middle item. What are you assuming when you start from the two ends instead?"
- `no_lecture` tb-confident_wrong-search-1 turn 2 (3 sentences): "Let's test that idea on a small case. Take a sorted list of seven numbers and look for the number in the middle. If you start at the two ends, which items do you check first, and does that match what page 1 says you do?"
- `no_lecture` tb-right_weak_reasoning-gears-1 turn 0 (3 sentences): "Welcome, let's work on gears and cadence today. Our first idea is gear ratio. Explain it in your own words, as if you were teaching a classmate."
- `no_lecture` tb-right_weak_reasoning-search-1 turn 0 (3 sentences): "Hello, and welcome to your binary search session. Let's start with the idea of halving. Explain it in your own words, as if you were teaching it to a classmate."
- `no_lecture` tb-full_coverage-gears-1 turn 0 (3 sentences): "Welcome, and let's dig into gears and cadence today. Your first idea is gear ratio. Explain it in your own words, as if you were teaching a classmate."
- `no_lecture` tb-off_topic-interest-1 turn 0 (3 sentences): "Welcome, let's work on compound interest together. Today's idea is the growth factor. Explain it in your own words, as if you were teaching it to a classmate."
- and 7 more in turns.json

## Cost

$0.0003 per coach turn and $0.001 per scenario. A typical day has one voice teach-back (about the length of one scenario): $0.001. Mean 2.0s per turn.
