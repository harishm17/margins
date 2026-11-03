"""Fast tests for checks.py, spend.py and report helpers. No database, no model, no network."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import checks  # noqa: E402
from checks import (  # noqa: E402
    bare_currency_count,
    check_topic,
    claim_quote_substring_rate,
    concepts_per_topic_in_range,
    excerpt_terms,
    grounding_share,
    has_latex,
    item_concept_ids_valid,
    interactive_structure,
    latex_hygiene,
    letter_references,
    mc_letter_reference_check,
    near_duplicate_statements,
    notes_structure,
    objectives_all_mapped,
    prereq_graph_acyclic,
    quiz_structure,
    recall_copy_check,
    significant_numbers,
    solved_structure,
    summarize_model,
    token_jaccard,
    unbalanced_dollar,
    warmup_not_in_quiz,
)


# ---------------------------------------------------------------- LaTeX hygiene


@pytest.mark.parametrize(
    "text",
    ["The cost is $x = 5$ here.", "Use $10^6$ samples", "$P(A)=0.4$ and $P(B)=0.5$", "Display $$\\int_0^1 f$$ ok", "Money: \\$100 and \\$5"],
)
def test_normal_math_and_escaped_currency_are_clean(text):
    assert not unbalanced_dollar(text)
    assert bare_currency_count(text) == 0


def test_unbalanced_dollar():
    assert unbalanced_dollar("Costs $5 today")
    assert unbalanced_dollar("The value $x = 5 is wrong")
    assert unbalanced_dollar("Display $$x = 5 is open")
    assert not unbalanced_dollar("Inline `a $ b` and\n```\n$ ls\n```\nstay plain")


def test_bare_currency_from_the_audit():
    assert bare_currency_count("You win $500 if i + j = 7 and lose $100 otherwise") == 2
    assert bare_currency_count("The payoff is $500 and the stake $100.") == 2
    assert bare_currency_count("A single $5 bill") == 1
    assert bare_currency_count("It costs $100 per year, then $x = 3$ more") == 1


def test_currency_that_looks_like_a_math_span_is_not_flagged():
    assert bare_currency_count("Expected value $5 \\cdot 0.2 + 3$") == 0
    assert bare_currency_count("$2x + 1 = 7$") == 0


def test_plain_text_latex():
    assert has_latex("Bayes' $P(A|B)$")
    assert has_latex("the \\alpha level")
    assert not has_latex("Conditional probability")
    assert not has_latex("Use `$HOME` in the shell")


def test_latex_hygiene_by_field():
    examples = [
        {
            "title": "Coin $P(H)$",
            "problem_statement": "Pay $5 to play.",
            "solution_steps": [{"step_number": 1, "description": "Set up", "work": "$x=1$", "explanation": "ok"}],
            "final_answer": "- done",
            "key_concepts": ["Bayes", "\\frac{a}{b}"],
        }
    ]
    found = latex_hygiene(checks.SOLVED, examples)
    assert found["plain_text_latex"] == ["[0].title", "[0].key_concepts[1]"]
    assert found["bare_currency"] == ["[0].problem_statement"]
    assert found["unbalanced_dollar"] == ["[0].problem_statement"]


# ---------------------------------------------------------------- option letters


def test_letter_references_strict_and_loose():
    refs = letter_references("Option C is wrong, D is the addition rule. See (B).")
    assert "Option C" in refs["strict"] and "(B)" in refs["strict"]
    assert refs["loose"] == ["C is", "D is"]


def test_letter_references_ignore_math_and_code():
    refs = letter_references("If $A$ is independent of $B$ then `C is` fine and $P(B)$ is small.")
    assert refs == {"strict": [], "loose": []}


def test_letter_references_ignore_content_descriptions():
    refs = letter_references("The addition rule applies because the events are disjoint.")
    assert refs == {"strict": [], "loose": []}


def test_mc_check_counts_only_multiple_choice():
    questions = [
        {"question_type": "multiple_choice", "explanation": "Option C is wrong; the rule is additive."},
        {"question_type": "multiple_choice", "explanation": "The sum rule applies."},
        {"question_type": "true_false", "explanation": "Option B is irrelevant here."},
    ]
    result = mc_letter_reference_check(questions)
    assert result["multiple_choice"] == 2
    assert result["flagged"] == 1 and result["flagged_strict"] == 1
    assert result["details"][0]["index"] == 0


# ---------------------------------------------------------------- recall copy


def test_significant_numbers_ignore_0_1_2_and_normalise():
    assert significant_numbers("Take 1 of 2 coins, 0 heads, 3 flips, 10 draws, 0.50 chance, 1,000 trials") == {
        "3", "10", "0.5", "1000"
    }
    assert significant_numbers("a probability of .25 and 25%") == {"0.25", "25"}


def test_recall_copy_flags_questions_that_reuse_the_example_numbers():
    reference = "A bag has 5 red and 7 blue marbles. Draw 3 without replacement."
    questions = [
        {"question_text": "A bag has 5 red and 7 blue marbles. What is P(red)?"},  # copied
        {"question_text": "A bag has 5 red and 9 blue marbles. What is P(red)?"},  # new number
        {"question_text": "Flip a coin 2 times. What is the chance of heads?"},  # < 2 significant numbers
        {"question_text": "Draw 3 marbles from 5 red and 7 blue."},  # copied
    ]
    result = recall_copy_check(questions, reference)
    assert result["with_numbers"] == 3
    assert result["copied"] == 2
    assert result["rate"] == pytest.approx(2 / 3)
    assert [d["index"] for d in result["details"]] == [0, 3]


def test_recall_copy_ignores_new_scenarios_that_share_small_numbers():
    notes = (
        "A die has 6 faces. " + "Sets and Venn diagrams are a way to picture events. " * 20
        + "There are 12 months, 4 seasons and 3 meals in this unrelated paragraph."
    )
    questions = [
        # New scenario: its numbers occur in the notes, but nowhere together with its words.
        {"question_text": "A restaurant offers 4 starters, 6 mains and 3 desserts. How many meals?"},
    ]
    assert recall_copy_check(questions, notes)["copied"] == 0


def test_recall_copy_rate_is_none_without_numeric_questions():
    assert recall_copy_check([{"question_text": "Define independence."}], "5 and 7")["rate"] is None


# ---------------------------------------------------------------- structure


NOTES = """# Hashing

## Overview
Hashing maps keys to slots.

## Key Concepts
- a
## How It Works
text
## Common Pitfalls
text
## Exam-Ready Recap
- one
- two
- three
- four
- five
- six
"""


def test_notes_structure_finds_sections_and_bullets():
    result = notes_structure(NOTES, word_band=(10, 50))
    assert result["sections_ok"] and result["has_title"]
    assert result["recap_bullets"] == 6 and result["recap_bullets_ok"]
    assert result["in_word_band"]


def test_notes_structure_reports_missing_sections_and_band():
    result = notes_structure("# T\n\n## Overview\nshort", word_band=(900, 1400))
    assert "Key Concepts" in result["sections_missing"]
    assert not result["in_word_band"] and not result["recap_bullets_ok"]


def test_notes_headings_inside_code_blocks_do_not_count():
    text = "# T\n\n```md\n## Overview\n```\n"
    assert "Overview" in notes_structure(text)["sections_missing"]


def test_example_and_quiz_structure():
    solved = [{"solution_steps": [1, 2, 3], "final_answer": "x"}, {"solution_steps": [1], "final_answer": " "}]
    result = solved_structure(solved, 3)
    assert not result["count_ok"] and result["steps"] == [3, 1] and result["missing_final_answer"] == 1

    interactive = [{"steps": [1, 2, 3]}, {"steps": [1] * 9}]
    result = interactive_structure(interactive, 2, "medium")
    assert result["count_ok"] and result["problems_in_step_band"] == 1

    quiz = [
        {"question_type": "multiple_choice", "options": [1, 2, 3]},
        {"question_type": "numerical"},
    ]
    result = quiz_structure(quiz, 10, ["multiple_choice", "numerical", "true_false"])
    assert result["types"] == {"multiple_choice": 1, "numerical": 1}
    assert result["types_missing"] == ["true_false"]
    assert result["mc_not_four_options"] == 1 and not result["count_ok"]


# ---------------------------------------------------------------- grounding


def test_excerpt_terms_drop_stopwords_and_short_words():
    terms = excerpt_terms(["The hash function distributes keys; however, collisions happen."])
    assert {"hash", "function", "distributes", "collisions", "happen"} <= terms or "hash" not in terms
    assert "however" not in terms and "keys" not in terms  # stopword, under five letters


def test_grounding_share():
    excerpts = ["A hash function distributes keys across slots. Collisions are resolved by chaining."]
    notes = (
        "# Hashing\n\n"
        "A hash function distributes keys across the table slots evenly.\n"
        "Collisions are resolved by chaining in this design.\n"
        "Bananas ripen faster near apples in warm kitchens.\n"
        "Short one.\n"
    )
    result = grounding_share(notes, excerpts)
    assert result["sentences"] == 3
    assert result["grounded"] == 2
    assert result["share"] == pytest.approx(2 / 3)


def test_grounding_counts_math_that_shares_a_symbol_with_the_excerpts():
    result = grounding_share("The variance equals $Var(X) = 4$ for this case.", ["Define Var(X) as the spread."])
    assert result["grounded"] == 1


# ---------------------------------------------------------------- overlap


def test_token_jaccard():
    assert token_jaccard("a b c", "a b c") == 1.0
    assert token_jaccard("a b c d", "a b x y") == pytest.approx(2 / 6)
    assert token_jaccard("", "a") == 0.0


def test_near_duplicates_only_across_topics():
    statements = {
        "t1": ["A fair coin is flipped three times. What is the probability of two heads?", "Unique first problem about urns."],
        "t2": ["A fair coin is flipped three times. What is the probability of exactly two heads?"],
        "t3": ["Compute the mean of a Poisson variable."],
    }
    pairs = near_duplicate_statements(statements, threshold=0.6)
    assert len(pairs) == 1
    assert (pairs[0]["topic_a"], pairs[0]["topic_b"]) == ("t1", "t2")
    # Two similar statements inside one topic are not reported.
    assert near_duplicate_statements({"t1": ["same words here", "same words here"]}) == []


# ---------------------------------------------------------------- one topic, one model


def _quiz_questions():
    return [
        {
            "question_type": "multiple_choice",
            "question_text": "A bag has 5 red and 7 blue marbles. P(red)?",
            "options": [{"id": x, "text": x} for x in "ABCD"],
            "correct_answer": "A",
            "explanation": "Option B is wrong.",
            "concepts_tested": ["probability"],
        },
        {
            "question_type": "true_false",
            "question_text": "Independence means P(A and B) = P(A)P(B).",
            "correct_answer": True,
            "explanation": "Yes.",
            "concepts_tested": ["independence"],
        },
    ]


def test_check_topic_and_summary():
    solved = [
        {
            "title": "Marbles",
            "problem_statement": "A bag has 5 red and 7 blue marbles. Find P(red).",
            "solution_steps": [{"step_number": 1, "description": "Count", "work": "5+7=12", "explanation": "total"}],
            "final_answer": "- 5/12",
            "key_concepts": ["probability"],
        }
    ]
    outputs = {checks.NOTES: NOTES, checks.SOLVED: solved, checks.QUIZ: _quiz_questions()}
    result = check_topic(outputs, ["hash function distributes keys"], requested={"examples": 1, "questions": 2})
    assert result["solved"]["count_ok"] and result["quiz"]["count_ok"]
    assert result["mc_letter_refs"]["flagged"] == 1
    assert result["recall_copy"]["copied"] == 1
    assert result["latex"] == {"plain_text_latex": 0, "unbalanced_dollar": 0, "bare_currency": 0}

    summary = summarize_model({"t1": result}, {"t1": checks.problem_statements(solved, None)})
    assert summary["mc_letter_refs"] == 1 and summary["mc_letter_refs_strict"] == 1
    assert summary["quiz_recall_copy_rate"] == 1.0
    assert summary["notes_count"] == 1 and summary["duplicate_example_pairs"] == 0


def test_check_topic_without_notes_skips_recall_copy():
    result = check_topic({checks.QUIZ: _quiz_questions()}, [])
    assert "skipped" in result["recall_copy"]


# ---------------------------------------------------------------- concept graph


def _concept(cid, objectives=(0,)):
    return {"id": cid, "name": f"Concept {cid}", "objective_indexes": list(objectives)}


def test_claim_quote_substring_rate():
    chunks = {"k1": "The  law of total probability\nsplits an event over a partition.", "k2": "Bayes’ rule reverses a conditional."}
    claims = [
        {"concept_id": "c1", "chunk_id": "k1", "quote": "law of total probability splits"},  # whitespace differs
        {"concept_id": "c1", "chunk_id": "k2", "quote": "Bayes' rule reverses"},  # curly apostrophe
        {"concept_id": "c2", "chunk_id": "k1", "quote": "a sentence the chunk never says"},
        {"concept_id": "c2", "chunk_id": "gone", "quote": "anything"},  # chunk not in the excerpts
    ]
    result = claim_quote_substring_rate(claims, chunks)
    assert (result["total"], result["matched"]) == (4, 2)
    assert result["rate"] == 0.5 and not result["ok"]
    assert [f["chunk_id"] for f in result["failures"]] == ["k1", "gone"]
    assert claim_quote_substring_rate(claims[:2], chunks)["ok"]
    assert claim_quote_substring_rate([], chunks) == {"total": 0, "matched": 0, "rate": None, "ok": True, "failures": []}


def test_claim_quote_gate_is_98_percent():
    chunks = {"k": "alpha beta"}
    good = {"concept_id": "c", "chunk_id": "k", "quote": "alpha"}
    bad = {"concept_id": "c", "chunk_id": "k", "quote": "zzz"}
    assert claim_quote_substring_rate([good] * 49 + [bad], chunks)["ok"]  # 49/50 = 98%
    assert not claim_quote_substring_rate([good] * 49 + [bad, bad], chunks)["ok"]  # 49/51


@pytest.mark.parametrize("count,ok", [(2, False), (3, True), (8, True), (9, False), (0, False)])
def test_concepts_per_topic_in_range(count, ok):
    result = concepts_per_topic_in_range([_concept(f"c{i}") for i in range(count)])
    assert result["count"] == count and result["ok"] is ok


def test_objectives_all_mapped():
    concepts = [_concept("a", [0]), _concept("b", [2])]
    result = objectives_all_mapped(concepts, 3)
    assert result["unmapped"] == [1] and not result["ok"]
    assert objectives_all_mapped(concepts + [_concept("c", [1, 7])], 3)["ok"]
    # A topic with no objectives has nothing to map.
    assert objectives_all_mapped([], 0)["ok"]


def test_prereq_graph_acyclic():
    chain = [{"source_id": "a", "target_id": "b", "type": "prerequisite"}, {"source_id": "b", "target_id": "c", "type": "prerequisite"}]
    assert prereq_graph_acyclic(chain)["ok"]
    loop = chain + [{"source_id": "c", "target_id": "a", "type": "prerequisite"}]
    result = prereq_graph_acyclic(loop)
    assert not result["ok"] and set(result["cycle"]) == {"a", "b", "c"}
    # Only prerequisite edges count: a confusable pair is allowed to point both ways.
    assert prereq_graph_acyclic(chain + [{"source_id": "c", "target_id": "a", "type": "confusable"}])["ok"]
    assert not prereq_graph_acyclic([{"source_id": "a", "target_id": "a", "type": "prerequisite"}])["ok"]


def test_item_concept_ids_valid():
    known = ["c1", "c2"]
    quiz = [
        {"question_text": "q1", "concept_ids": ["c1"], "options": [{"id": "A", "confusable_concept_id": "c2"}, {"id": "B"}]},
        {"question_text": "q2", "concept_ids": ["c1", "c9"]},  # unknown id
        {"question_text": "q3", "concept_ids": []},  # untagged
        {"question_text": "q4", "concept_ids": [], "prerequisite_topic": "Earlier topic"},  # review item: no tag is right
        {"question_text": "q5", "concept_ids": ["c2"], "options": [{"id": "A", "confusable_concept_id": "zzz"}]},
    ]
    practice = [{"title": "p", "concept_ids": ["c2"], "steps": [{"concept_ids": ["c2"]}, {"concept_ids": ["nope"]}]}]
    result = item_concept_ids_valid({"quiz": quiz, "interactive": practice}, known)
    assert result["total"] == 6 and result["valid"] == 2
    assert result["rate"] == pytest.approx(2 / 6) and not result["ok"]
    assert sorted(f["path"] for f in result["invalid"]) == ["interactive[0]", "quiz[1]", "quiz[2]", "quiz[4]"]
    assert item_concept_ids_valid({"quiz": quiz[:1]}, known)["ok"]
    assert item_concept_ids_valid({}, known) == {"total": 0, "valid": 0, "rate": None, "ok": True, "invalid": []}


def test_warmup_not_in_quiz():
    warmup = [
        {"question_text": "Which rule splits an event over a partition?"},
        {"question_text": "True or false: independent events satisfy P(A and B) = P(A)P(B)."},
    ]
    quiz = [
        {"question_text": "Which rule splits an event over a partition?"},  # copied
        {"question_text": "True or false: independent events satisfy P(A and B) = P(A)P(B)"},  # light rewording
        {"question_text": "Compute the posterior given a 1% prior and a 90% sensitive test."},
    ]
    result = warmup_not_in_quiz(warmup, quiz)
    assert not result["ok"] and result["reused"] == 2
    assert [(r["warmup_index"], r["quiz_index"]) for r in result["pairs"]] == [(0, 0), (1, 1)]
    assert warmup_not_in_quiz(warmup, quiz[2:])["ok"]
    assert warmup_not_in_quiz(warmup, [])["ok"]


def _graph(**changes):
    graph = {
        "objective_count": 2,
        "concepts": [_concept("c1", [0]), _concept("c2", [1]), _concept("c3", [0, 1])],
        "claims": [{"concept_id": "c1", "chunk_id": "k1", "quote": "law of total"}],
        "edges": [{"source_id": "c1", "target_id": "c2", "type": "prerequisite"}],
    }
    graph.update(changes)
    return graph


def test_check_topic_runs_the_concept_checks_and_tags_items_against_them():
    warmup = [{"question_type": "true_false", "question_text": "Chaining resolves collisions.", "correct_answer": True, "explanation": "Yes.", "concept_ids": ["c1"]}]
    quiz = [{"question_type": "true_false", "question_text": "Chaining resolves collisions.", "correct_answer": True, "explanation": "Yes.", "concept_ids": ["c7"]}]
    outputs = {checks.CONCEPTS: _graph(), checks.WARMUP: warmup, checks.QUIZ: quiz}
    result = check_topic(outputs, [], chunk_texts={"k1": "the law of total probability"})
    assert result["concepts"]["claim_quotes"]["ok"] and result["concepts"]["count"]["ok"]
    assert result["concepts"]["objectives"]["ok"] and result["concepts"]["prereq_acyclic"]["ok"]
    assert result["item_concept_ids"]["total"] == 2 and result["item_concept_ids"]["valid"] == 1
    assert result["warmup_not_in_quiz"]["reused"] == 1
    assert result["latex"]["unbalanced_dollar"] == 0  # warm-up questions get the quiz's text hygiene

    summary = summarize_model({"t1": result}, {})
    assert summary["concept_topics"] == 1 and summary["concept_count_ok"] == 1
    assert summary["claims_total"] == 1 and summary["claims_matched"] == 1 and summary["claim_quote_rate"] == 1.0
    assert summary["objectives_mapped_ok"] == 1 and summary["prereq_acyclic_ok"] == 1
    assert (summary["items_tagged"], summary["items_tagged_valid"]) == (2, 1)
    assert summary["warmup_topics"] == 1 and summary["warmup_reused_items"] == 1
    assert summary["item_tag_gate_ok"] is False and summary["warmup_reuse_gate_ok"] is False


def test_item_tags_are_not_checked_for_a_topic_without_concepts():
    quiz = [{"question_type": "true_false", "question_text": "x", "correct_answer": True, "explanation": "y"}]
    result = check_topic({checks.QUIZ: quiz}, [])
    assert "item_concept_ids" not in result and "concepts" not in result
    summary = summarize_model({"t1": result}, {})
    assert summary["concept_topics"] == 0
    assert summary["item_tag_gate_ok"] is None and summary["warmup_reuse_gate_ok"] is None
