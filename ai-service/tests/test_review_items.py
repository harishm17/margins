"""The review-item job: new tagged items for the concepts a review session lacks, appended to the topic's review bank."""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.content_generator.review_items import generate_review_items
from app.services.llm.base import LLMOutputError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, ReviewItemSet
from tests.db_helpers import new_id
from tests.test_warmup import world  # noqa: F401  (fixture)

pytestmark = pytest.mark.usefixtures("passthrough_support")


def _choice(n, concept_id, mode="recall", level="easy", confusable=None):
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=f"Question {n} about {concept_id[:6]}", correct_answer="A",
        explanation="e",
        options=[
            ChoiceOption(
                id=x, text=f"{n}{x}",
                misconception=None if x == "A" else f"idea {x}",
                confusable_concept_id=confusable if x == "B" else None,
            )
            for x in "ABCD"
        ],
        difficulty=level, concept_ids=[concept_id], mode=mode, source_excerpts=[1],
    )


def _llm(questions):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=ReviewItemSet(questions=questions))
    return llm


@pytest.fixture
async def twins(db, world):  # noqa: F811
    """The world's two concepts are near-twins (a confusable edge, the smaller id as source)."""
    low, high = sorted(world.concepts)
    await db.execute(
        "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
        "VALUES ($1, $2, $3, $4, 'confusable', 1, 0.9, 'llm', 'confirmed')",
        new_id(), world.project_id, low, high,
    )
    return world


async def _bank(db, topic_id):
    return await db.fetch("SELECT * FROM topic_quizzes WHERE topic_id = $1 AND kind = 'review_bank'", topic_id)


def _request(concept_ids, mode="recall", difficulty="easy"):
    return {"concept_ids": concept_ids, "mode": mode, "difficulty": difficulty}


class TestReviewItems:
    async def test_review_items_tagged_and_appended(self, db, twins):
        first_concept, second_concept = twins.concepts
        questions = [_choice(1, first_concept), _choice(2, first_concept), _choice(3, second_concept)]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(twins.topic_id, [_request([first_concept, second_concept])])

        assert result["total_items"] == 3
        rows = await _bank(db, twins.topic_id)
        assert len(rows) == 1
        stored = json.loads(rows[0]["questions"])
        assert [q["concept_ids"][0] for q in stored] == [first_concept, first_concept, second_concept]
        assert all(q["difficulty"] == "easy" and q["mode"] == "recall" for q in stored)
        assert all(q["sources"] and "source_excerpts" not in q for q in stored)

        # A second run appends to the same row; the first items keep their positions (their item keys).
        again = [_choice(4, second_concept, level="hard")]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(again)):
            await generate_review_items(twins.topic_id, [_request([second_concept], difficulty="hard")])
        rows = await _bank(db, twins.topic_id)
        assert [r["id"] for r in rows] == [rows[0]["id"]]
        after = json.loads(rows[0]["questions"])
        assert after[:3] == stored
        assert after[3]["difficulty"] == "hard" and after[3]["concept_ids"] == [second_concept]

    async def test_review_items_honour_requested_mode(self, db, twins):
        mean, variance = twins.concepts
        questions = [
            # A discrimination item names the twin on a wrong option.
            _choice(1, mean, mode="discrimination", level="medium", confusable=variance),
            # Asked for discrimination, the model wrote a plain recall item: not what was asked for.
            _choice(2, mean, mode="recall", level="medium"),
            # Names a concept that is not the concept's twin... it is the concept itself.
            _choice(3, mean, mode="discrimination", level="medium", confusable=mean),
        ]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(
                twins.topic_id, [_request([mean], mode="discrimination", difficulty="medium")]
            )

        assert result["total_items"] == 1
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert stored[0]["mode"] == "discrimination"
        assert stored[0]["concept_ids"] == [mean]
        wrong = [o for o in stored[0]["options"] if o.get("confusable_concept_id")]
        assert [o["confusable_concept_id"] for o in wrong] == [variance]

    async def test_an_item_for_a_concept_nobody_asked_for_is_dropped(self, db, twins):
        mean, variance = twins.concepts
        questions = [_choice(1, mean), _choice(2, variance), _choice(3, "not-a-concept")]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert result["total_items"] == 1
        assert result["concepts_without_items"] == []

    async def test_the_answer_key_support_check_runs_on_review_items(self, db, twins):
        mean = twins.concepts[0]
        seen = []

        async def drop_first(items, chunks):
            seen.append(len(items))
            return items[1:], 1

        questions = [_choice(1, mean), _choice(2, mean)]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)), \
                patch("app.services.content_generator.review_items.check_support", drop_first):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert seen == [2]
        assert result["dropped_unsupported"] == 1
        assert result["total_items"] == 1
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert [q["question_text"] for q in stored] == [questions[1].question_text]

    async def test_a_repeated_question_is_not_added_twice(self, db, twins):
        mean = twins.concepts[0]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, mean)])):
            await generate_review_items(twins.topic_id, [_request([mean])])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, mean), _choice(2, mean)])):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert result["total_items"] == 1
        assert len(json.loads((await _bank(db, twins.topic_id))[0]["questions"])) == 2

    async def test_nothing_usable_fails_and_stores_nothing(self, db, twins):
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, "unknown")])):
            with pytest.raises(LLMOutputError):
                await generate_review_items(twins.topic_id, [_request([twins.concepts[0]])])
        assert await _bank(db, twins.topic_id) == []

class TestManyConcepts:
    async def test_no_concept_is_dropped_when_a_job_asks_for_more_than_one_call_writes(self, db, twins):
        concepts = list(twins.concepts)
        for n in range(20):
            concepts.append(await db.fetchval(
                "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
                "VALUES ($1, $2, $3, $4, 's', 'concept', $5) RETURNING id",
                new_id(), twins.project_id, twins.topic_id, f"Extra {n}", 10 + n,
            ))
        provider = MockProvider()
        writes = []
        answer = provider.generate_structured

        async def generate_structured(messages, schema, **kwargs):
            if kwargs.get("purpose") == "review_items":
                writes.append([m.cache for m in messages])
            return await answer(messages, schema, **kwargs)

        provider.generate_structured = generate_structured
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider):
            result = await generate_review_items(twins.topic_id, [_request(concepts)])

        # The excerpts are cached from the first call on, so the second reads what the first wrote. (The first used to
        # go uncached: the second call paid for the cache write and a job of two calls never read it.)
        assert len(writes) > 1 and all(cached == [False, True, False] for cached in writes)
        assert result["concepts_without_items"] == []
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert {q["concept_ids"][0] for q in stored} == set(concepts)
        assert result["total_items"] == len(concepts) * 2

