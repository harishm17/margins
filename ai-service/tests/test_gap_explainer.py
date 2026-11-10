"""The gap explainer (spec 5.4): a short explanation of each missed or incorrect claim of one recall attempt,
grounded in that claim's source passage, each ending with a check question."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.content_generator.gap_explainer import generate_gap_explainer
from app.services.job_runner import PermanentJobError
from app.services.llm.schemas import GapExplanation, GapExplanationSet
from tests.db_helpers import add_chunk, new_id, seed_material, seed_project, seed_topic, seed_user

CHUNK_TEXT = [
    "A collision is two keys that land in one bucket. Chaining keeps a list of entries per bucket.",
    "The load factor is the number of entries divided by the number of buckets.",
    "A hash function maps a key to a bucket index.",
]
CLAIMS = [
    # (concept, claim text, chunk, verdict)
    ("Hash function", "A hash function maps a key to a bucket index.", 2, "covered"),
    ("Collision", "A collision is two keys that land in one bucket.", 0, "missing"),
    ("Collision", "Chaining keeps a list of entries per bucket.", 0, "partial"),
    ("Load factor", "The load factor is entries divided by buckets.", 1, "incorrect"),
]


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    material = await seed_material(db, project_id, filename="hashing.pdf", status="valid")
    chunks = [await add_chunk(db, material, i, text, page=i + 4, tokens=30) for i, text in enumerate(CHUNK_TEXT)]
    topic_id = await seed_topic(db, project_id, "Hash tables")
    concept_ids: dict[str, str] = {}
    claim_ids: list[str] = []
    for name, text, chunk_index, _ in CLAIMS:
        if name not in concept_ids:
            concept_ids[name] = new_id()
            await db.execute(
                "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
                "VALUES ($1, $2, $3, $4, 'summary', 'concept', $5)",
                concept_ids[name], project_id, topic_id, name, len(concept_ids),
            )
        claim_id = new_id()
        await db.execute(
            "INSERT INTO concept_claims (id, concept_id, text, quote, material_id, chunk_id, page_start, order_index) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
            claim_id, concept_ids[name], text, text, material, chunks[chunk_index], chunk_index + 4,
        )
        claim_ids.append(claim_id)
    return SimpleNamespace(user_id=user_id, project_id=project_id, topic_id=topic_id, claim_ids=claim_ids, concepts=concept_ids)


async def _attempt(db, world, *, kind="recall", verdicts=None, explainer=None, user_id=None):
    verdicts = verdicts or [verdict for *_, verdict in CLAIMS]
    result = {
        "status": "graded",
        "claims": [
            {
                "claim_id": claim_id,
                "concept_id": world.concepts[CLAIMS[i][0]],
                "verdict": verdict,
                "student_quote": "I wrote something" if verdict != "missing" else None,
                "misconception": "The student thinks it is entries per key." if verdict == "incorrect" else None,
                "kind": "misconception" if verdict == "incorrect" else None,
                "pointer": None,
            }
            for i, (claim_id, verdict) in enumerate(zip(world.claim_ids, verdicts))
        ],
    }
    attempt_id = new_id()
    await db.execute(
        "INSERT INTO recall_attempts (id, user_id, topic_id, kind, prompt_text, objective_index, answer_text, mode, result, explainer) "
        "VALUES ($1, $2, $3, $4, 'Explain hashing.', 0, 'my answer', 'text', $5::jsonb, $6::jsonb)",
        attempt_id, user_id or world.user_id, world.topic_id, kind, json.dumps(result),
        json.dumps(explainer) if explainer is not None else None,
    )
    return attempt_id


async def _explainer(db, attempt_id):
    raw = await db.fetchval("SELECT explainer FROM recall_attempts WHERE id = $1", attempt_id)
    return json.loads(raw) if isinstance(raw, str) else raw


def _gap(claim_id, **override):
    fields = dict(
        claim_id=claim_id,
        explanation="Two keys can hash to the same bucket. That is a collision, and it is why a bucket holds a list.",
        check_question="What happens when two keys hash to the same bucket?",
        check_answer="They collide, and the bucket keeps both entries in a list.",
    )
    fields.update(override)
    return GapExplanation(**fields)


def _llm(gaps):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=GapExplanationSet(gaps=gaps))
    return llm


async def keep_all(items, chunks):
    return items, 0


@pytest.fixture
def keep_support(monkeypatch):
    """The support check passes everything: for tests of what the explainer does with the model's entries.
    Tests that name the check themselves (or run the real one) do not use it."""
    monkeypatch.setattr("app.services.content_generator.gap_explainer.check_support", keep_all)


class TestGapExplainer:
    async def test_gap_explainer_covers_only_missed_claims(self, db, world, keep_support):
        attempt_id = await _attempt(db, world)
        missing, incorrect = world.claim_ids[1], world.claim_ids[3]
        llm = _llm([_gap(missing), _gap(incorrect)])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await generate_gap_explainer(attempt_id, world.user_id)

        # The covered and the partial claims are not in the prompt, and not in the answer.
        sent = "\n".join(message.content for message in llm.generate_structured.call_args.args[0])
        assert world.claim_ids[1] in sent and world.claim_ids[3] in sent
        assert world.claim_ids[0] not in sent and world.claim_ids[2] not in sent
        assert "Chaining keeps a list" not in sent.split("<gaps>")[1]
        assert llm.generate_structured.call_args.kwargs["purpose"] == "gap_explainer"

        stored = await _explainer(db, attempt_id)
        assert [gap["claim_id"] for gap in stored["gaps"]] == [missing, incorrect]
        assert result["gaps"] == stored["gaps"]
        assert stored["status"] == "ready"
        assert stored["gaps"][0]["concept_name"] == "Collision"
        assert stored["gaps"][0]["source"] == {"material_id": stored["gaps"][0]["source"]["material_id"], "filename": "hashing.pdf", "page": 4}


    async def test_each_gap_ends_with_check(self, db, world, keep_support):
        attempt_id = await _attempt(db, world)
        no_check = _gap(world.claim_ids[3], check_question="", check_answer="")
        llm = _llm([_gap(world.claim_ids[1]), no_check])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await generate_gap_explainer(attempt_id, world.user_id)
        stored = await _explainer(db, attempt_id)
        assert [gap["claim_id"] for gap in stored["gaps"]] == [world.claim_ids[1]]
        for gap in stored["gaps"]:
            assert gap["check"]["question"].strip().endswith("?")
            assert gap["check"]["answer"].strip()
        # A gap without a check is not shown half-made.
        assert [item["claim_id"] for item in stored["skipped"]] == [world.claim_ids[3]]
        assert stored["skipped"][0]["page"] == 5
        assert stored["skipped"][0]["concept_name"] == "Load factor"


    async def test_a_gap_the_pages_do_not_support_is_not_written(self, db, world, monkeypatch):
        attempt_id = await _attempt(db, world)

        async def drop_first(items, chunks):
            return items[1:], 1

        monkeypatch.setattr("app.services.content_generator.gap_explainer.check_support", drop_first)
        llm = _llm([_gap(world.claim_ids[1]), _gap(world.claim_ids[3])])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await generate_gap_explainer(attempt_id, world.user_id)
        stored = await _explainer(db, attempt_id)
        assert [gap["claim_id"] for gap in stored["gaps"]] == [world.claim_ids[3]]
        assert [item["claim_id"] for item in stored["skipped"]] == [world.claim_ids[1]]

    async def test_the_prompt_fences_the_student_text_and_the_pages(self, db, world, keep_support):
        attempt_id = await _attempt(db, world)
        llm = _llm([_gap(world.claim_ids[1]), _gap(world.claim_ids[3])])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await generate_gap_explainer(attempt_id, world.user_id)
        system, user = (message.content for message in llm.generate_structured.call_args.args[0])
        assert "150 words" in user
        assert "untrusted" in user.lower()
        assert "<gaps>" in user and "<excerpt " in user and "<student_misconception>" in user
        assert "student thinks it is entries per key" in user
        # The student's whole answer is not needed and is not sent.
        assert "my answer" not in user
        assert system and "not instructions" in system.lower()


    async def test_a_visit_recorded_before_the_explainer_was_written_is_kept(self, db, world, keep_support):
        attempt_id = await _attempt(db, world, explainer={"viewedAt": "2026-10-30T10:00:00+00:00"})
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_gap(world.claim_ids[1]), _gap(world.claim_ids[3])])):
            await generate_gap_explainer(attempt_id, world.user_id)
        stored = await _explainer(db, attempt_id)
        assert stored["viewedAt"] == "2026-10-30T10:00:00+00:00"
        assert len(stored["gaps"]) == 2

    async def test_another_students_attempt_is_not_found(self, db, world, keep_support):
        attempt_id = await _attempt(db, world)
        other = await seed_user(db)
        with pytest.raises(PermanentJobError):
            await generate_gap_explainer(attempt_id, other)


