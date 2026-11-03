# Generation eval: full-generation

- Date: 2026-11-02. Code: `60adcba763`, branch `feat/v3-map`.
- Corpora and topics generated: mit-18.05 4, mit-6.006 4. Topics came from: the app's course planner.
- Models: opus:medium. Content types: concepts, warmup, notes, solved, interactive, quiz.
- Requested per topic: 3 examples of each kind, 10 quiz questions, medium difficulty, comprehensive notes.
- Judge: off.
- Spend: $7.37 generation, $0.13 topic extraction, $0.00 judge; total $7.50 (caps: $8.00 total, $3.00 judge).

## Cost and latency

Cost uses the app's own price table (`usage.py`) on the token counts the API reported. A topic's cost is the sum of the mean cost of each content type, so the 12-topic projection is for one set of all the types generated here, times 12. Latency is wall time of the app's generator call.

| Model | Per topic | Projected, 12 topics | Concepts | Warm-up | Notes | Worked examples | Practice problems | Quiz | Seconds per topic | Total spent |
|---|---|---|---|---|---|---|---|---|---|---|
| opus:medium | $0.928 | $11.13 | $0.118 (36s) | $0.121 (30s) | $0.127 (44s) | $0.162 (65s) | $0.219 (94s) | $0.181 (84s) | 353s | $7.373 |

Per-type cells are mean cost per generation and, in brackets, mean seconds.

| Model | Calls | Input tokens | Output tokens | Cache write tokens | Cache read tokens |
|---|---|---|---|---|---|
| opus:medium | 56 | 462,866 | 276,087 | 0 | 0 |

### Failed generations

A failed generation is a result: it is not scored, and its cost is in the total.

- opus:medium, warmup, 1 topic(s) (mit-6.006/Priority queues and PQ sort): LLMOutputError: Warm-up had 1 usable questions of 5 requested

## Automatic checks

No model is involved. These are lexical heuristics: they find things worth reading, they do not prove content right or wrong (see the README for what each can miss). Counts are over every topic generated.

| Check | opus:medium |
|---|---|
| Plain-text fields with `$` or backslash sequences | 39 |
| Fields with unbalanced `$` | 0 |
| Fields with bare currency | 0 |
| MC explanations naming an option letter (any / strict `Option C`, `(B)`) | 0 / 0 of 30 |
| Quiz recall-copy rate (questions whose numbers all come from this model's notes or examples) | 19% (5 of 27) |
| Concept claim quotes found in their chunk (gate: 98% or more) | 100% (149 of 149) PASS |
| Topics with 3-8 concepts | 8/8 (mean 5.9) |
| Topics where every objective has a concept | 8/8 |
| Topics with an acyclic prerequisite graph | 8/8 |
| Items whose concept tags are all valid (gate: 100%) | 100% (155 of 155) PASS |
| Warm-up questions the topic quiz repeats (gate: 0) | 0 PASS |
| Notes with all expected sections | 0/8 |
| Notes inside the requested word band | 0/8 (mean 1757 words) |
| Notes with 5-8 recap bullets | 8/8 |
| Worked-example sets with the requested count | 8/8 |
| Practice sets with the requested count | 8/8 |
| Quizzes with the requested question count | 5/8 |
| Grounding proxy (share of notes sentences sharing vocabulary with the excerpts) | 61% |
| Near-duplicate example statements across topics (Jaccard > 0.6) | 0 |

## Judge

The judge was not run.

## Side by side

Topic `mit-18.05/t00-sets-and-counting-principles`. One notes section and two quiz questions per model, as stored (multiple-choice options already shuffled by the app).

### opus:medium

Notes, section "Key concepts":

> ### Sets and elements
>
> A **set** $S$ is a collection of elements.
>
> - $x \in S$ means "$x$ is an element of $S$".
> - $A \subset S$ ("$A$ is a subset of $S$") means every element of $A$ is also in $S$.
> - The **empty set** $\emptyset$ has no elements.
> - If $S$ is finite, $|S|$ (or $\#S$) is the number of elements of $S$.
>
> *Example:* For $S = \{1,2,3,4,5,6\}$ (die faces) and $E = \{2,4,6\}$, we have $4 \in E$, $E \subset S$, and $|E| = 3$.
>
> ### Union, intersection, complement, difference
>
> Let $A, B \subset S$.
>
> | Operation | Notation | Meaning | Key word |
> |---|---|---|---|
> | Union | $A \cup B$ | elements in $A$ or $B$ (or both) | **or** |
> | Intersection | $A \cap B$ | elements in both $A$ and $B$ | **and** |
> | Complement | $A^c$ or $S - A$ | elements of $S$ not in $A$ | **not** |
> | Difference | $A - B$ | elements in $A$ that are not in $B$ | **but not** |
>
> $A$ and $B$ are **disjoint** if they share no elements, that is, $A \cap B = \emptyset$.
>
> *Example:* In $S = \{1,\dots,6\}$, let $E = \{2,4,6\}$ (even) and $H = \{4,5,6\}$ (at least 4). Then:
>
> - $E \cup H = \{2,4,5,6\}$
> - $E \cap H = \{4,6\}$
> - $E^c = \{1,3,5\}$
> - $E - H = \{2\}$
>
> The same set can often be written in several ways. For instance, $A - B = A \cap B^c$, because "in $A$ but not in $B$" is the same as "in $A$ and in the complement of $B$". You can check this with the example: $E \cap H^c = \{2,4,6\} \cap \{1,2,3\} = ...

Quiz, multiple_choice:

> Let $S = \{1,2,3,4,5,6,7,8,9,10\}$. Let $A$ be the even numbers in $S$ and $B$ the multiples of 3 in $S$. Which set is $A \cap B^c$?
>   A. $\{1,2,4,5,7,8,10\}$
>   B. $\{1,5,7\}$
>   C. $\{6\}$
>   D. $\{2,4,8,10\}$
> Key: D
> Explanation: $A = \{2,4,6,8,10\}$ and $B = \{3,6,9\}$, so $B^c = \{1,2,4,5,7,8,10\}$. The intersection keeps elements that are in **both** $A$ and $B^c$: even numbers that are not multiples of 3, which gives $\{2,4,8,10\}$. This is the same as the difference $A - B$.

Quiz, numerical:

> In a data-science club, 31 members use Python, 17 use R, and 8 use both. Every member uses at least one of the two languages. How many members does the club have?
> Key: 40.0
> Explanation: Let $P$ be the Python users and $R$ the R users. By inclusion-exclusion, $|P \cup R| = |P| + |R| - |P \cap R| = 31 + 17 - 8 = 40$. Adding 31 and 17 counts the 8 members who use both twice, so the overlap is subtracted once.

