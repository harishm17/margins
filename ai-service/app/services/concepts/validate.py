"""Validation of a topic's concept extraction before anything is written.

The model's output is checked in code: quotes must be real text from the named chunk, ids must
exist, the prerequisite graph must be acyclic, minimal and point backwards in the course. Bad
pieces are dropped and counted so one bad claim does not fail the topic.
"""
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, Sequence, Set, Tuple, TypeVar

from app.services.llm.schemas import (
    ConceptExtraction,
    ExtractedClaim,
    ExtractedConcept,
    ExtractedEdge,
    FocusQuestion,
    ProposedLink,
    RecallPrompt,
)

MAX_QUOTE_CHARS = 300

# Links between topics of a unit are kept from this confidence.
MIN_LINK_CONFIDENCE = 0.6

_QUOTE_MARKS = str.maketrans(
    {
        "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
        "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
        "−": "-",
    }
)
_SPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Collapse whitespace and map curly quotes and dashes to ASCII: how a quote is stored."""
    return _SPACE.sub(" ", (text or "").translate(_QUOTE_MARKS)).strip()


# What a PDF turned into markdown carries and a model leaves out, or adds, when it copies a passage.
_MARKUP_TAG = re.compile(r"</?(?:sup|sub|br|b|i|em|strong|u)\s*/?>", re.IGNORECASE)
_MARKUP_CHARS = str.maketrans("", "", "*_`")
_ELLIPSIS = re.compile(r"\.{3,}|…")
# Each part of a quote that leaves words out must be this long, so a few stray letters do not pass as a quote.
MIN_ELIDED_PART_CHARS = 12


def normalize_for_match(text: str) -> str:
    """The text as it is compared when a quote is looked for in a chunk.

    On top of `normalize`: emphasis marks (`**`, `_`, backticks) and <sup>/<sub> tags are dropped, compatibility
    forms are folded (maths italic letters, ligatures, superscript digits), and whitespace is removed, so
    `_O_ ( _n_ )` in a chunk and `O(n)` in a quote are the same text. Only for comparing: what is stored is `normalize`.
    """
    folded = unicodedata.normalize("NFKC", _MARKUP_TAG.sub("", text or "")).translate(_QUOTE_MARKS)
    return _SPACE.sub("", folded.translate(_MARKUP_CHARS))


def quote_in(quote: str, prepared_text: str) -> bool:
    """True when `quote` is text of the chunk whose `normalize_for_match` form is `prepared_text`.

    Every place that checks a model's quote against course text uses this one rule. A quote that leaves words out
    with an ellipsis holds when each part is in the chunk, in order."""
    whole = normalize_for_match(quote)
    if not whole:
        return False
    if whole in prepared_text:
        return True
    parts = [part for part in (normalize_for_match(piece) for piece in _ELLIPSIS.split(quote or "")) if part]
    if len(parts) < 2 or any(len(part) < MIN_ELIDED_PART_CHARS for part in parts):
        return False
    at = 0
    for part in parts:
        found = prepared_text.find(part, at)
        if found < 0:
            return False
        at = found + len(part)
    return True


@dataclass
class ValidatedGraph:
    concepts: List[ExtractedConcept] = field(default_factory=list)
    claims: List[ExtractedClaim] = field(default_factory=list)
    # source and target are a concept key from this extraction or the id of a prior concept.
    # A confusable edge is ordered by those strings; the writer re-orders it once ids exist.
    edges: List[ExtractedEdge] = field(default_factory=list)
    focus_questions: List[FocusQuestion] = field(default_factory=list)
    recall_prompts: List[RecallPrompt] = field(default_factory=list)
    dropped: Dict[str, int] = field(default_factory=dict)
    unmapped_objectives: List[int] = field(default_factory=list)


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


class _Link(Protocol):
    """What cycle handling reads from an edge; ExtractedEdge and ProposedLink both have it."""

    source: str
    target: str
    confidence: float


_E = TypeVar("_E", bound=_Link)


def _find_cycle(edges: Sequence[_E]) -> Optional[List[_E]]:
    """Return the edges of one directed cycle, or None."""
    out: Dict[str, List[_E]] = {}
    for edge in edges:
        out.setdefault(edge.source, []).append(edge)
    state: Dict[str, int] = {}  # 1 on the current path, 2 finished

    def visit(node: str, path: List[_E]) -> Optional[List[_E]]:
        state[node] = 1
        for edge in out.get(node, []):
            if state.get(edge.target) == 1:
                start = next((i for i, e in enumerate(path) if e.source == edge.target), len(path))
                return path[start:] + [edge]
            if state.get(edge.target) is None:
                found = visit(edge.target, path + [edge])
                if found:
                    return found
        state[node] = 2
        return None

    for node in list(out):
        if state.get(node) is None:
            found = visit(node, [])
            if found:
                return found
    return None


def _break_cycles(edges: Sequence[_E]) -> Tuple[List[_E], int]:
    edges = list(edges)
    removed = 0
    while True:
        cycle = _find_cycle(edges)
        if not cycle:
            return edges, removed
        # Lowest confidence goes; on a tie the edge listed last goes.
        order = {id(e): i for i, e in enumerate(edges)}
        weakest = min(cycle, key=lambda e: (e.confidence, -order[id(e)]))
        edges = [e for e in edges if e is not weakest]
        removed += 1


def _reduce(edges: List[ExtractedEdge]) -> Tuple[List[ExtractedEdge], int]:
    """Drop an edge when its target is still reachable from its source without it."""
    kept: List[ExtractedEdge] = []
    for edge in edges:
        others = [e for e in edges if e is not edge]
        out: Dict[str, List[str]] = {}
        for other in others:
            out.setdefault(other.source, []).append(other.target)
        seen: Set[str] = set()
        stack = [edge.source]
        reachable = False
        while stack and not reachable:
            for nxt in out.get(stack.pop(), []):
                if nxt == edge.target:
                    reachable = True
                    break
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        if not reachable:
            kept.append(edge)
    return kept, len(edges) - len(kept)


def validate_claims(
    claims: Sequence[ExtractedClaim], concept_keys: Set[str], chunks: Dict[str, str]
) -> Tuple[List[ExtractedClaim], int]:
    """The claims whose concept is known and whose quote is real, short text from the chunk it names, with text and quote
    cleaned, and how many were dropped. One claim per (concept, quote). `chunks` maps chunk id to its text; a quote is
    looked for with `quote_in`. Shared by the extraction and by the re-quoting of concepts that lost their claims."""
    kept: List[ExtractedClaim] = []
    seen: Set[Tuple[str, str]] = set()
    dropped = 0
    prepared = {chunk_id: normalize_for_match(text) for chunk_id, text in chunks.items()}
    for claim in claims:
        quote = normalize(claim.quote)
        chunk_text = prepared.get(claim.chunk_id)
        text = claim.text.strip()
        if (
            claim.concept_key not in concept_keys
            or not quote or not text or len(quote) > MAX_QUOTE_CHARS
            or chunk_text is None or not quote_in(quote, chunk_text)
            or (claim.concept_key, quote) in seen
        ):
            dropped += 1
            continue
        seen.add((claim.concept_key, quote))
        kept.append(claim.model_copy(update={"text": text, "quote": quote}))
    return kept, dropped


def validate_extraction(
    raw: ConceptExtraction,
    chunks: Dict[str, str],
    prior_concepts: Dict[str, dict],
    course_order: Dict[str, int],
    *,
    topic_id: Optional[str] = None,
    objective_count: Optional[int] = None,
) -> ValidatedGraph:
    """Check one topic's extraction.

    chunks: chunk id -> text. prior_concepts: id -> {name, summary, topic_id} for the active
    concepts of earlier topics. course_order: topic id -> position in the course; topic_id is this
    topic's own id, and without it this topic counts as the last one. objective_count is the
    number of the topic's objectives; without it the highest index mentioned stands in.
    """
    dropped = {"concepts": 0, "claims": 0, "edges": 0, "focus_questions": 0, "recall_prompts": 0}

    if objective_count is None:
        mentioned = [
            i
            for items in (
                [i for c in raw.concepts for i in c.objective_indexes],
                [q.objective_index for q in raw.focus_questions],
                [p.objective_index for p in raw.recall_prompts],
            )
            for i in items
        ]
        objective_count = max(mentioned) + 1 if mentioned else 0

    # Concepts, first pass: one concept per key. The first listed wins; a later concept with the same
    # key is dropped, so a claim never attaches to a concept the model listed twice by accident.
    keys: Set[str] = set()
    unique: List[ExtractedConcept] = []
    for concept in raw.concepts:
        if concept.key in keys:
            dropped["concepts"] += 1
            continue
        keys.add(concept.key)
        unique.append(concept)

    # Claims: for a known concept, a real, short quote from the named chunk.
    claims, dropped_claims = validate_claims(raw.claims, keys, chunks)
    dropped["claims"] += dropped_claims

    # Concepts, second pass: at least one surviving claim, objective indexes in range.
    claimed = {claim.concept_key for claim in claims}
    concepts: List[ExtractedConcept] = []
    for concept in unique:
        if concept.key not in claimed:
            dropped["concepts"] += 1
            continue
        indexes = sorted({i for i in concept.objective_indexes if 0 <= i < objective_count})
        concepts.append(
            concept.model_copy(update={"objective_indexes": indexes, "difficulty": _clamp(concept.difficulty)})
        )
    keys = {concept.key for concept in concepts}

    # Edges: known ids, no self edges, prerequisites point backwards, one edge per triple.
    own_order = course_order.get(topic_id) if topic_id is not None else None
    if own_order is None:
        own_order = max(course_order.values(), default=-1) + 1

    def order_of(ref: str) -> Optional[int]:
        if ref in keys:
            return own_order
        if ref in prior_concepts:
            prior_topic = prior_concepts[ref].get("topic_id")
            return course_order.get(prior_topic) if prior_topic is not None else None
        return None

    best: Dict[Tuple[str, str, str], ExtractedEdge] = {}
    for edge in raw.edges:
        source, target = edge.source, edge.target
        known = (source in keys or source in prior_concepts) and (target in keys or target in prior_concepts)
        if not known or source == target:
            dropped["edges"] += 1
            continue
        if edge.type == "confusable" and source > target:
            source, target = target, source
        if edge.type == "prerequisite":
            before, after = order_of(source), order_of(target)
            if before is None or after is None or before > after:
                dropped["edges"] += 1
                continue
        edge = edge.model_copy(
            update={
                "source": source, "target": target, "confidence": _clamp(edge.confidence),
                "weight": edge.weight if edge.type == "encompasses" else 1.0,
                "evidence_quote": normalize(edge.evidence_quote) if edge.evidence_quote else None,
            }
        )
        triple = (source, target, edge.type)
        if triple in best:
            dropped["edges"] += 1
            if best[triple].confidence >= edge.confidence:
                continue
        best[triple] = edge

    edges: List[ExtractedEdge] = []
    for kind in ("prerequisite", "encompasses", "confusable"):
        group = [e for e in best.values() if e.type == kind]
        if kind != "confusable":
            group, cycles = _break_cycles(group)
            dropped["edges"] += cycles
        if kind == "prerequisite":
            group, redundant = _reduce(group)
            dropped["edges"] += redundant
        edges.extend(group)

    # Focus questions and recall prompts: one per objective, in range.
    focus: List[FocusQuestion] = []
    for question in raw.focus_questions:
        if not (0 <= question.objective_index < objective_count) or any(
            q.objective_index == question.objective_index for q in focus
        ) or not question.question.strip():
            dropped["focus_questions"] += 1
            continue
        chunk_id = question.chunk_id if question.chunk_id in chunks else None
        focus.append(question.model_copy(update={"chunk_id": chunk_id}))
    prompts: List[RecallPrompt] = []
    for prompt in raw.recall_prompts:
        if not (0 <= prompt.objective_index < objective_count) or any(
            p.objective_index == prompt.objective_index for p in prompts
        ) or not prompt.prompt.strip():
            dropped["recall_prompts"] += 1
            continue
        prompts.append(prompt)

    mapped = {i for concept in concepts for i in concept.objective_indexes}
    unmapped = [i for i in range(objective_count) if i not in mapped]

    return ValidatedGraph(
        concepts=concepts, claims=claims, edges=edges, focus_questions=focus,
        recall_prompts=prompts, dropped=dropped, unmapped_objectives=unmapped,
    )


def validate_links(
    proposed: List[ProposedLink],
    candidate_pairs: Set[Tuple[str, str]],
    existing_encompasses: List[Tuple[str, str]],
    shown_quotes: Dict[str, List[str]],
) -> Tuple[List[ProposedLink], Dict[str, int]]:
    """Check the edges `link_concepts` proposed. `candidate_pairs` holds each offered pair as
    (smaller id, larger id); only those pairs survive, as `confusable` or `encompasses` at
    MIN_LINK_CONFIDENCE or above, one edge per (source, target, type). A confusable edge is
    ordered by id. `encompasses` cycles are broken by dropping the lowest-confidence edge, as in
    validate_extraction; edges already stored count as part of the graph and are never the one
    dropped. An edge that carries an evidence_quote is dropped unless the quote is a substring of
    one of the quotes `shown_quotes` holds for its two concepts (by `quote_in`), the way a
    claim is in validate_extraction; an edge with no quote is kept. Returns the surviving edges
    and a count of what was dropped."""
    dropped = {"edges": 0}
    best: Dict[Tuple[str, str, str], ProposedLink] = {}
    for edge in proposed:
        source, target = edge.source, edge.target
        confidence = _clamp(edge.confidence)
        if (
            source == target
            or (min(source, target), max(source, target)) not in candidate_pairs
            or edge.type not in ("confusable", "encompasses")
            or confidence < MIN_LINK_CONFIDENCE
        ):
            dropped["edges"] += 1
            continue
        quote = normalize(edge.evidence_quote) if edge.evidence_quote else None
        if quote and not any(
            quote_in(quote, normalize_for_match(shown)) for end in (source, target) for shown in shown_quotes.get(end, [])
        ):
            dropped["edges"] += 1
            continue
        if edge.type == "confusable" and source > target:
            source, target = target, source
        edge = edge.model_copy(
            update={
                "source": source, "target": target, "confidence": confidence,
                "weight": edge.weight if edge.type == "encompasses" else 1.0,
                "evidence_quote": quote,
            }
        )
        triple = (source, target, edge.type)
        if triple in best:
            dropped["edges"] += 1
            if best[triple].confidence >= edge.confidence:
                continue
        best[triple] = edge

    confusable = [e for e in best.values() if e.type == "confusable"]
    encompasses = [e for e in best.values() if e.type == "encompasses"]
    # Stored edges ride along with a confidence no proposal can reach, so they are never the weakest.
    stored = [
        ProposedLink(source=s, target=t, type="encompasses", weight=1.0, confidence=2.0) for s, t in existing_encompasses
    ]
    kept, cycles = _break_cycles(stored + encompasses)
    dropped["edges"] += cycles
    return confusable + [e for e in kept if e.confidence <= 1.0], dropped
