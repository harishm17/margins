"""A2's item judge: one call per topic over every question the app stored for it (warm-up, quiz, review items and
the topic's exam questions), with the topic's source excerpts.

The automatic checks (checks.py) catch what the text shows: self-correction, copied exam headers, a key that is not an
option, equal options, the longest option being right. The judge reads what text alone cannot: whether the key is
right, whether two options are right, whether the excerpts teach enough to answer, whether a sentence is garbled,
whether the writer thinks aloud, and whether the answer can be guessed. These are the faults Q1's second stage will
judge, so A2's counts are its baseline. Questions are shown without the generator that wrote them.

A fault counts only with its note (the words at fault and what is right): without one nobody can check the flag, and
the 2026-11-10 v2 run had 6 of its 8 flags with none. Each fault is an object with its own note, and a fault whose note
is empty is tallied apart as `unexplained`, not as a flag.

Rendering, the prompt and the tally are plain functions and are unit tested; `judge_topics` makes the calls through a
MeteredProvider, so the spend caps apply.
"""
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field

DEFECTS = ("wrong_key", "two_correct", "not_answerable", "ungrammatical", "thinking_aloud", "guessable", "other")
Defect = Literal["wrong_key", "two_correct", "not_answerable", "ungrammatical", "thinking_aloud", "guessable", "other"]


class Fault(BaseModel):
    kind: Defect
    note: str = Field(description="The words at fault and what is right, in one or two sentences")


class ItemVerdict(BaseModel):
    number: int = Field(description="The question's number")
    faults: List[Fault] = Field(default_factory=list, description="Every fault the question has, each with its note; empty when it has none")


class ItemJudgeResult(BaseModel):
    items: List[ItemVerdict]

    @classmethod
    def example(cls) -> "ItemJudgeResult":
        return cls(items=[])

    @classmethod
    def example_for(cls, prompt: str) -> "ItemJudgeResult":
        """What the mock provider returns: a verdict with no fault for every question in the prompt."""
        numbers = sorted({int(n) for n in re.findall(r'<question number="(\d+)"', prompt)})
        return cls(items=[ItemVerdict(number=n) for n in numbers])


# ---------------------------------------------------------------------------- rendering


def render_question(number: int, item: Dict[str, Any]) -> str:
    kind = item.get("question_type", "")
    lines = [f'<question number="{number}" type="{kind}">', str(item.get("question_text", "")).strip()]
    for option in item.get("options") or []:
        lines.append(f"{option.get('id')}. {option.get('text')}")
    if kind == "short_answer":
        lines.append(f"Sample answer: {item.get('sample_answer', '')}")
        lines.append(f"Key points: {'; '.join(map(str, item.get('key_points') or []))}")
    else:
        unit = f" {item['unit']}" if item.get("unit") else ""
        tolerance = f" (tolerance {item['tolerance']})" if item.get("tolerance") is not None else ""
        lines.append(f"Answer key: {item.get('correct_answer')}{unit}{tolerance}")
    lines.append(f"Explanation: {str(item.get('explanation', '')).strip()}")
    lines.append("</question>")
    return "\n".join(lines)


# ---------------------------------------------------------------------------- the prompt

SYSTEM = """You check study questions before a university student sees them. The questions were written from excerpts of the student's own course files and will be used for self-testing, so a wrong key or a question the student cannot answer from what they studied teaches them something false or wastes their time. You review each question independently and strictly, and you never invent a fault to seem thorough."""


def instructions(count: int) -> str:
    return f"""Above are {count} questions written from the excerpts. Check each one on its own, as a careful teacher would before handing it out. Work each question yourself first: find the answer from the excerpts and your knowledge of the subject, then compare it with the key.

For each question, list every fault it has from this set, or none:
- wrong_key: the answer key is wrong; for a written answer, the sample answer or a key point is wrong.
- two_correct: a multiple-choice question has more than one option a well-prepared student could defend as correct.
- not_answerable: a student who studied the excerpts could not answer it, because it needs facts or methods the excerpts do not teach. Background a course at this level assumes, such as arithmetic and algebra, is fine.
- ungrammatical: a sentence in the question, its options or its explanation is ungrammatical or garbled enough that a student has to reread it.
- thinking_aloud: the text shows its writer working something out or correcting itself, such as "wait", "let me recompute", or an answer that changes partway through.
- guessable: a student who does not know the material can still pick the answer, because the question gives it away or only one option fits its wording.
- other: any other fault a student would notice; its note says what the fault is.

Give each fault its own note that names the words at fault and what is right, in one or two sentences. A person checks every fault against its note, so a fault without one cannot be checked and is not counted. Most good questions have no fault. Return one verdict for every question number from 1 to {count}."""


def build_messages(excerpts_text: str, items: List[Dict[str, Any]]):
    from app.services.llm.base import LLMMessage

    questions = "\n\n".join(render_question(n, entry["item"]) for n, entry in enumerate(items, 1))
    return [
        LLMMessage(role="system", content=SYSTEM),
        LLMMessage(role="user", content="Source excerpts from the student's course files:\n\n" + excerpts_text),
        LLMMessage(role="user", content=questions),
        LLMMessage(role="user", content=instructions(len(items))),
    ]


# ---------------------------------------------------------------------------- results


def _faults(verdict: Dict[str, Any]) -> List[tuple]:
    """(kind, note) for each fault of a raw verdict. A verdict judged before faults carried their own notes has a list
    of `defects` and one `note` for all of them."""
    if "faults" in verdict:
        return [(fault.get("kind"), str(fault.get("note") or "")) for fault in verdict.get("faults") or []]
    note = str(verdict.get("note") or "")
    return [(defect, note) for defect in verdict.get("defects") or []]


def verdicts_by_ref(items: List[Dict[str, Any]], result: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The judge's verdicts keyed by each item's `ref` (such as "quiz-3"); a question it gave no verdict is absent,
    and a fault outside the set is kept as "other". `defects` are the faults that have a note; one without is in
    `unexplained`."""
    by_number = {v.get("number"): v for v in result.get("items") or []}
    out: Dict[str, Dict[str, Any]] = {}
    for n, entry in enumerate(items, 1):
        verdict = by_number.get(n)
        if verdict is None:
            continue
        faults = [(kind if kind in DEFECTS else "other", note.strip()) for kind, note in _faults(verdict)]
        out[entry["ref"]] = {
            "defects": sorted({kind for kind, note in faults if note}),
            "unexplained": sorted({kind for kind, note in faults if not note}),
            "note": " ".join(dict.fromkeys(note for _, note in faults if note)),
        }
    return out


def explained(verdict: Dict[str, Any]) -> tuple:
    """(faults with a note, faults without) of a stored verdict. One stored before `unexplained` existed has every
    fault in `defects`: with an empty note none of them can be checked."""
    if "unexplained" in verdict:
        return list(verdict["defects"]), list(verdict["unexplained"])
    if str(verdict.get("note") or "").strip():
        return list(verdict["defects"]), []
    return [], list(verdict["defects"])


def tally(judged: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Per kind (the part of `ref` before its number): questions judged, questions with a fault that has its note,
    each such fault's count, and the questions whose only faults came without a note (`unexplained`: not flags,
    because nobody can check them, but shown so a judge that stops explaining is seen)."""
    kinds: Dict[str, Dict[str, Any]] = {}
    for record in judged:
        for ref, verdict in (record.get("verdicts") or {}).items():
            kind = ref.rsplit("-", 1)[0]
            entry = kinds.setdefault(kind, {"judged": 0, "flagged": 0, "unexplained": 0, "by_defect": {d: 0 for d in DEFECTS}})
            entry["judged"] += 1
            noted, bare = explained(verdict)
            if noted:
                entry["flagged"] += 1
            elif bare:
                entry["unexplained"] += 1
            for defect in noted:
                entry["by_defect"][defect] += 1
    for entry in kinds.values():
        entry["rate"] = round(entry["flagged"] / entry["judged"], 3) if entry["judged"] else None
    return kinds


# ---------------------------------------------------------------------------- the run


async def judge_topics(*, provider, groups: Dict[str, Dict[str, Any]], judge_dir: Path, log) -> Dict[str, Any]:
    """Judge every group (one topic: {"excerpts": text, "items": [{"ref", "item"}]}) not judged before, all at once (the
    calls join one batch when the provider batches). Returns {"failed": [...], "stopped": [...]}."""
    import asyncio

    from spend import SpendLimitReached

    from adapters import call_sink

    judge_dir.mkdir(parents=True, exist_ok=True)
    failed: List[str] = []
    stopped: List[str] = []

    async def one(key: str, group: Dict[str, Any]) -> None:
        path = judge_dir / f"{key}.json"
        refs = [entry["ref"] for entry in group["items"]]
        earlier = json.loads(path.read_text()) if path.exists() else {}
        # A resumed run can store more of a topic's items after the topic was judged (the PR 1.7 A2 resume judged only
        # warm-up): the topic is judged again whenever its items differ from the ones the record judged.
        if earlier.get("result") is not None and earlier.get("refs") == refs:
            return
        if not group["items"]:
            return
        record: Dict[str, Any] = {"group": key, "refs": refs, "judge_model": provider.spec.label}
        with call_sink() as calls:
            try:
                result = await provider.generate_structured(
                    build_messages(group["excerpts"], group["items"]), ItemJudgeResult, max_tokens=16000, purpose="judge"
                )
                record["result"] = result.model_dump()
                record["verdicts"] = verdicts_by_ref(group["items"], record["result"])
            except SpendLimitReached as exc:
                stopped.append(key)
                log(f"  judge stopped for {key}: {exc}")
                return
            except Exception as exc:  # one group failing should not end the run
                record["error"] = f"{type(exc).__name__}: {exc}"
                failed.append(key)
                log(f"  judge failed for {key}: {record['error'][:160]}")
        # The earlier judgment's calls stay in the record: they were spent, and a resumed run's budget counts them.
        record["calls"] = (earlier.get("calls") or []) + calls
        path.write_text(json.dumps(record, indent=2) + "\n")
        if "error" not in record:
            log(f"  judged {key}: {len(group['items'])} questions")

    await asyncio.gather(*(one(key, group) for key, group in groups.items()))
    return {"failed": failed, "stopped": stopped}


def load_judged(judge_dir: Path) -> List[Dict[str, Any]]:
    if not judge_dir.exists():
        return []
    return [json.loads(p.read_text()) for p in sorted(judge_dir.glob("*.json"))]
