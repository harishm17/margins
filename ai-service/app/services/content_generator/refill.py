"""Refill a generated set that checks left under its floor (finding 102).

The support check (support_check.py) and the item checks (a hint that gives the answer away, a distractor without its
misconception) drop items. When that leaves a set under the fewest items the generator accepts, the job used to fail
and the student got nothing. With SUPPORT_REFILL on, the generator asks once for the missing items, runs them through
the same checks and serves what it has: a set still short of the count asked for, but at or above the floor, is
stored, and its job result says how many items it lacks (`short_by`) and how many the refill added (`refilled`).
A set still under the floor after the refill fails as before. The refill's model calls run inside the job's billing
scope like every other call.
"""
from typing import Any, Awaitable, Callable, Dict, List, Sequence, Tuple

from app.config import settings


def refill_wanted(have: int, floor: int) -> bool:
    """True when the flag is on and a set of `have` items is under its `floor`."""
    return settings.SUPPORT_REFILL and have < floor


async def refill_once(
    kept: List[Any],
    wanted: int,
    floor: int,
    regenerate: Callable[[int], Awaitable[Sequence[Any]]],
) -> Tuple[List[Any], int]:
    """`kept` plus one regeneration of the items missing from `wanted`, when `kept` is under `floor` and the flag is on.

    `regenerate(missing)` returns new items that already passed the generator's checks. Returns the items (at most
    `wanted`) and how many the refill added. Never asks twice."""
    if not refill_wanted(len(kept), floor):
        return kept, 0
    extra = list(await regenerate(max(1, wanted - len(kept))))
    merged = (kept + extra)[:wanted]
    return merged, len(merged) - len(kept)


def short_by(wanted: int, have: int) -> int:
    return max(0, wanted - have)


def refill_figures(wanted: int, have: int, refilled: int) -> Dict[str, int]:
    """What a job result says about a refill: items added and items still missing from the count asked for."""
    return {"refilled": refilled, "short_by": short_by(wanted, have)}
