"""Tests for concept extraction validation: quotes, ids, cycles, reduction, ordering."""
import pytest

from app.services.concepts.validate import normalize, validate_extraction
from app.services.llm.schemas import (
    ConceptExtraction,
    ExtractedClaim,
    ExtractedConcept,
    ExtractedEdge,
    FocusQuestion,
    RecallPrompt,
)

CHUNKS = {"ch1": 'The “mean”  of a set is the sum divided\nby the count — always.', "ch2": "Variance measures spread."}


def _concept(key, objectives=(0,)):
    return ExtractedConcept(
        key=key, name=f"Concept {key}", summary="An idea.", kind="concept",
        objective_indexes=list(objectives), difficulty=0.5,
    )


def _claim(key, quote="Variance measures spread.", chunk="ch2"):
    return ExtractedClaim(concept_key=key, text="A claim.", quote=quote, chunk_id=chunk)


def _edge(source, target, type="prerequisite", confidence=0.8, weight=1.0):
    return ExtractedEdge(source=source, target=target, type=type, weight=weight, confidence=confidence)


def _raw(concepts, claims=None, edges=(), objectives=(0,)):
    claims = claims if claims is not None else [_claim(c.key) for c in concepts]
    return ConceptExtraction(
        concepts=concepts, claims=claims, edges=list(edges),
        focus_questions=[FocusQuestion(objective_index=i, question="Why?", chunk_id="ch2") for i in objectives],
        recall_prompts=[RecallPrompt(objective_index=i, prompt="Explain it.") for i in objectives],
    )


def _run(raw, prior=None, order=None, **kwargs):
    return validate_extraction(raw, CHUNKS, prior or {}, order or {}, **kwargs)


def test_claim_quote_must_be_substring():
    raw = _raw([_concept("a")], [_claim("a"), _claim("a", quote="Not in the chunk at all.")])
    graph = _run(raw)
    assert len(graph.claims) == 1
    assert graph.dropped["claims"] == 1


def test_quote_matches_after_whitespace_and_quote_normalisation():
    quote = 'The "mean" of a set is the sum divided by the count - always.'
    graph = _run(_raw([_concept("a")], [_claim("a", quote=quote, chunk="ch1")]))
    assert len(graph.claims) == 1
    assert graph.dropped["claims"] == 0
    assert normalize("a’s   b\n– c“d”") == "a's b - c\"d\""


def test_a_quote_copied_without_the_chunks_markdown_is_still_a_quote_and_is_stored_as_the_model_wrote_it():
    # Bug: a PDF chunk carries markdown (`**`, `_x_`) and maths italics; the model quotes the plain words and the
    # claim was dropped as "not in the chunk".
    chunks = {"ch1": "Insertion appends _x_ to the end in amortized _O_ (1) time, then **swaps** up."}
    quote = "Insertion appends x to the end in amortized O(1) time"
    graph = validate_extraction(_raw([_concept("a")], [_claim("a", quote=quote, chunk="ch1")]), chunks, {}, {})
    assert [c.quote for c in graph.claims] == [quote]
    assert graph.dropped["claims"] == 0


def test_concept_without_claims_dropped():
    raw = _raw([_concept("a"), _concept("b")], [_claim("a")])
    graph = _run(raw)
    assert [c.key for c in graph.concepts] == ["a"]
    assert graph.dropped["concepts"] == 1


def test_unknown_edge_ids_dropped():
    raw = _raw([_concept("a"), _concept("b")], edges=[_edge("a", "b"), _edge("a", "zzz"), _edge("nope", "b")])
    graph = _run(raw)
    assert [(e.source, e.target) for e in graph.edges] == [("a", "b")]
    assert graph.dropped["edges"] == 2


def test_cycle_broken_at_lowest_confidence():
    raw = _raw(
        [_concept("a"), _concept("b"), _concept("c")],
        edges=[_edge("a", "b", confidence=0.9), _edge("b", "c", confidence=0.4), _edge("c", "a", confidence=0.8)],
    )
    graph = _run(raw)
    assert sorted((e.source, e.target) for e in graph.edges) == [("a", "b"), ("c", "a")]


def test_prerequisite_transitive_reduction():
    raw = _raw(
        [_concept("a"), _concept("b"), _concept("c")],
        edges=[_edge("a", "b"), _edge("b", "c"), _edge("a", "c")],
    )
    graph = _run(raw)
    assert sorted((e.source, e.target) for e in graph.edges) == [("a", "b"), ("b", "c")]


@pytest.mark.parametrize(
    "prior, order, kept, dropped",
    [
        (
            {
                "p-early": {"name": "Early", "summary": "s", "topic_id": "t1"},
                "p-late": {"name": "Late", "summary": "s", "topic_id": "t3"},
            },
            {"t1": 0, "t2": 1, "t3": 2},
            "p-early",
            1,
        ),
        (  # a prior concept whose topic is unknown, or has none, cannot be placed before this one
            {
                "p-known": {"name": "Known", "summary": "s", "topic_id": "t1"},
                "p-unknown": {"name": "Unknown", "summary": "s", "topic_id": "t-gone"},
                "p-none": {"name": "None", "summary": "s", "topic_id": None},
            },
            {"t1": 0, "t2": 1},
            "p-known",
            2,
        ),
    ],
    ids=["later_topic", "unknown_topic"],
)
def test_prerequisite_must_point_backwards(prior, order, kept, dropped):
    raw = _raw([_concept("a")], edges=[_edge(source, "a") for source in prior])
    graph = _run(raw, prior, order, topic_id="t2")
    assert [(e.source, e.target) for e in graph.edges] == [(kept, "a")]
    assert graph.dropped["edges"] == dropped


def test_confusable_pair_listed_both_ways_kept_once():
    raw = _raw([_concept("a"), _concept("b")], edges=[_edge("b", "a", "confusable", 0.7), _edge("a", "b", "confusable", 0.9)])
    graph = _run(raw)
    assert len(graph.edges) == 1 and graph.edges[0].confidence == 0.9


def test_every_objective_mapped_or_reported():
    raw = _raw([_concept("a", [0]), _concept("b", [1])], objectives=(0, 1, 2))
    graph = _run(raw, objective_count=3)
    assert graph.unmapped_objectives == [2]
    assert "unmapped_objectives" not in graph.dropped
    mapped = _run(_raw([_concept("a", [0, 1])], objectives=(0, 1)), objective_count=2)
    assert mapped.unmapped_objectives == []


def test_weight_is_forced_to_one_except_on_encompasses():
    raw = _raw(
        [_concept("a"), _concept("b"), _concept("c")],
        edges=[
            _edge("a", "b", "prerequisite", weight=0.5),
            _edge("a", "c", "encompasses", weight=0.5),
            _edge("b", "c", "confusable", weight=0.25),
        ],
    )
    weights = {e.type: e.weight for e in _run(raw).edges}
    assert weights == {"prerequisite": 1.0, "encompasses": 0.5, "confusable": 1.0}


