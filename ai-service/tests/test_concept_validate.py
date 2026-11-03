"""Tests for concept extraction validation: quotes, ids, cycles, reduction, ordering."""
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


def test_claim_in_wrong_chunk_or_too_long_dropped():
    long_chunk = {"ch3": "word " * 100}
    raw = _raw([_concept("a")], [_claim("a", quote="Variance measures spread.", chunk="ch1"),
                                 _claim("a", quote=("word " * 100).strip(), chunk="ch3")])
    graph = validate_extraction(raw, {**CHUNKS, **long_chunk}, {}, {})
    assert graph.claims == []
    assert graph.dropped["claims"] == 2


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


def test_edge_to_dropped_concept_is_dropped():
    raw = _raw([_concept("a"), _concept("b")], [_claim("a")], edges=[_edge("a", "b")])
    assert _run(raw).edges == []


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


def test_prerequisite_must_point_backwards():
    prior = {
        "p-early": {"name": "Early", "summary": "s", "topic_id": "t1"},
        "p-late": {"name": "Late", "summary": "s", "topic_id": "t3"},
    }
    order = {"t1": 0, "t2": 1, "t3": 2}
    raw = _raw([_concept("a")], edges=[_edge("p-early", "a"), _edge("p-late", "a")])
    graph = _run(raw, prior, order, topic_id="t2")
    assert [(e.source, e.target) for e in graph.edges] == [("p-early", "a")]
    assert graph.dropped["edges"] == 1


def test_confusable_canonical_order():
    raw = _raw([_concept("a"), _concept("b")], edges=[_edge("b", "a", type="confusable")])
    graph = _run(raw)
    assert [(e.source, e.target) for e in graph.edges] == [("a", "b")]


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


def test_bad_objective_indexes_removed_and_prompts_filtered():
    raw = _raw([_concept("a", [0, 7])], objectives=(0, 5))
    graph = _run(raw, objective_count=2)
    assert graph.concepts[0].objective_indexes == [0]
    assert [q.objective_index for q in graph.focus_questions] == [0]
    assert [p.objective_index for p in graph.recall_prompts] == [0]


def test_focus_question_with_unknown_chunk_gets_no_chunk():
    raw = _raw([_concept("a")])
    raw.focus_questions[0].chunk_id = "nowhere"
    graph = _run(raw)
    assert len(graph.focus_questions) == 1
    assert graph.focus_questions[0].chunk_id is None
    known = _run(_raw([_concept("a")]))
    assert known.focus_questions[0].chunk_id == "ch2"


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


def test_duplicate_concept_key_keeps_the_first_and_counts_the_rest():
    first = _concept("a", [0])
    second = _concept("a", [1])
    second.name = "Duplicate"
    raw = _raw([first, second], [_claim("a"), _claim("a", quote="Variance")], objectives=(0, 1))
    graph = _run(raw, objective_count=2)
    assert [c.name for c in graph.concepts] == ["Concept a"]
    assert graph.concepts[0].objective_indexes == [0]
    assert len(graph.claims) == 2
    assert graph.dropped["concepts"] == 1
    assert graph.dropped["claims"] == 0


def test_claim_for_an_unknown_concept_key_is_counted_once():
    raw = _raw([_concept("a")], [_claim("a"), _claim("ghost")])
    graph = _run(raw)
    assert len(graph.claims) == 1
    assert graph.dropped["claims"] == 1
    assert graph.dropped["concepts"] == 0


def test_cycle_tie_drops_the_edge_listed_last():
    raw = _raw(
        [_concept("a"), _concept("b"), _concept("c")],
        edges=[_edge("a", "b", confidence=0.7), _edge("b", "c", confidence=0.7), _edge("c", "a", confidence=0.7)],
    )
    graph = _run(raw)
    assert sorted((e.source, e.target) for e in graph.edges) == [("a", "b"), ("b", "c")]
    assert graph.dropped["edges"] == 1


def test_prerequisite_from_a_prior_concept_with_an_unknown_topic_is_dropped():
    prior = {
        "p-known": {"name": "Known", "summary": "s", "topic_id": "t1"},
        "p-unknown": {"name": "Unknown", "summary": "s", "topic_id": "t-gone"},
        "p-none": {"name": "None", "summary": "s", "topic_id": None},
    }
    order = {"t1": 0, "t2": 1}
    raw = _raw([_concept("a")], edges=[_edge("p-known", "a"), _edge("p-unknown", "a"), _edge("p-none", "a")])
    graph = _run(raw, prior, order, topic_id="t2")
    assert [(e.source, e.target) for e in graph.edges] == [("p-known", "a")]
    assert graph.dropped["edges"] == 2
