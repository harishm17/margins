"""Spend control: a hard stop on dollars, checked before every model call.

`SpendTracker` holds the caps and the running total. Before a call, the caller asks it to
`reserve` the call's estimated cost; if the total spent so far, plus everything reserved by calls
still in flight, plus this estimate would pass a cap, `SpendLimitReached` is raised and the call
is not made. After the call, `settle` replaces the reservation with the real cost.

Estimates come from the app's own price table (`estimate_cost_usd`, passed in as `cost_fn`) with
a rough token count, so one call can overshoot a cap by the error of its estimate; no call is
started once the cap is reached. This module has no app imports, so it is unit tested alone.
"""
import json
from collections import defaultdict
from typing import Callable, Dict, List, Optional, Tuple

GENERATION = "generation"
JUDGE = "judge"

# Characters per token for prompt text. Course text is heavy on math and symbols, which
# tokenise worse than prose, so this is deliberately low (a higher token estimate).
CHARS_PER_TOKEN = 3.2

# Output tokens (thinking included) to assume before a model/purpose has been seen. These are
# guesses from typical runs; once a call of the same model and purpose has finished, 1.25 times
# the mean of the observed outputs is used instead.
DEFAULT_OUTPUT_TOKENS = {
    "section_notes": 4000,
    "solved_examples": 6000,
    "interactive_examples": 7000,
    "topic_quiz": 6000,
    "extract_topics": 1500,
    "extract_concepts": 7000,
    "warmup": 3000,
    "judge": 8000,
    # The tutoring eval (evals/tutoring): a practice tutor reply with a short private analysis, the
    # small leak judge, and one Opus judge call per scenario.
    "tutor": 700,
    "router": 100,
    "judge_tutoring": 2500,
    # The teach-back teaches-before-probe judge: one asking turn, a one-sentence reason and a verdict (about $0.008 a call at opus:medium).
    "judge_teach_back": 700,
    # An Ask reply (an explanation of under 150 words, or a question back) and its check card.
    "chat": 500,
    # A voice coach turn: one or two spoken sentences, or a tool call.
    "voice": 250,
    # A short-answer grade (the grading eval, evals/grading): points, 2-3 sentences of feedback, one check per key point.
    "grade_short_answer": 600,
    # A recall-answer grade (evals/grading, recall arm): a private analysis (v1) or thinking (v2), then a verdict per claim
    # with the student's quote and a pointer.
    "recall_grading": 1200,
}
FALLBACK_OUTPUT_TOKENS = 6000
OBSERVED_MARGIN = 1.25


class SpendLimitReached(Exception):
    """The next call would pass a spending cap. Nothing more should be sent."""

    def __init__(self, kind: str, cap: float, spent: float, estimate: float):
        self.kind = kind
        self.cap = cap
        self.spent = spent
        self.estimate = estimate
        super().__init__(
            f"{kind} spend cap reached: ${spent:.4f} spent, next call estimated at ${estimate:.4f}, cap ${cap:.2f}"
        )


def estimate_prompt_tokens(texts: List[str], schema_json: Optional[dict] = None) -> int:
    chars = sum(len(text) for text in texts)
    if schema_json is not None:
        chars += len(json.dumps(schema_json))
    return int(chars / CHARS_PER_TOKEN) + 1


class SpendTracker:
    """Caps on total spend (`max_usd`, generation plus judge) and on judge spend alone.

    `cost_fn(model, input_tokens, output_tokens, cache_write_tokens)` returns dollars, or None
    for an unpriced model (counted as zero).
    """

    def __init__(
        self,
        max_usd: float,
        max_judge_usd: float,
        cost_fn: Callable[[str, int, int, int], Optional[float]],
    ):
        self.max_usd = max_usd
        self.max_judge_usd = max_judge_usd
        self.cost_fn = cost_fn
        self.spent: Dict[str, float] = defaultdict(float)
        self._reserved: Dict[int, Tuple[str, float]] = {}
        self._next_token = 0
        self._observed: Dict[Tuple[str, str], List[int]] = defaultdict(list)
        # The first limit hit for each kind of call (generation, judge).
        self.stops: Dict[str, SpendLimitReached] = {}

    # -- totals

    @property
    def total_spent(self) -> float:
        return sum(self.spent.values())

    def _in_flight(self, kind: Optional[str] = None) -> float:
        return sum(cost for k, cost in self._reserved.values() if kind in (None, k))

    def add_past_spend(self, kind: str, usd: float) -> None:
        """Count money already spent by an earlier run of the same results folder."""
        self.spent[kind] += usd

    # -- estimates

    def expected_output_tokens(self, model: str, purpose: str) -> int:
        seen = self._observed.get((model, purpose))
        if seen:
            return int(sum(seen) / len(seen) * OBSERVED_MARGIN)
        return DEFAULT_OUTPUT_TOKENS.get(purpose, FALLBACK_OUTPUT_TOKENS)

    def estimate_call(self, model: str, purpose: str, prompt_tokens: int) -> float:
        # Every input token is priced as plain input. The first generation of a content type
        # caches only the short system prompt, so cache writes and reads are negligible.
        cost = self.cost_fn(model, prompt_tokens, self.expected_output_tokens(model, purpose), 0)
        return cost or 0.0

    # -- the gate

    def reserve(self, kind: str, model: str, purpose: str, prompt_tokens: int) -> Tuple[int, float]:
        """Allow a call or raise SpendLimitReached. Returns (token, estimate) for `settle`."""
        estimate = self.estimate_call(model, purpose, prompt_tokens)
        problem = None
        if self.total_spent + self._in_flight() + estimate > self.max_usd:
            problem = SpendLimitReached(kind, self.max_usd, self.total_spent, estimate)
        elif kind == JUDGE and self.spent[JUDGE] + self._in_flight(JUDGE) + estimate > self.max_judge_usd:
            problem = SpendLimitReached(kind, self.max_judge_usd, self.spent[JUDGE], estimate)
        if problem is not None:
            self.stops.setdefault(kind, problem)
            raise problem
        token = self._next_token
        self._next_token += 1
        self._reserved[token] = (kind, estimate)
        return token, estimate

    def settle(self, token: int, model: str, purpose: str, actual_usd: float, output_tokens: Optional[int]) -> None:
        kind, _ = self._reserved.pop(token)
        self.spent[kind] += actual_usd
        if output_tokens:
            self._observed[(model, purpose)].append(output_tokens)

    def release(self, token: int) -> None:
        """Drop a reservation for a call that never reached the API."""
        self._reserved.pop(token, None)
