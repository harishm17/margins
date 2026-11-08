"""Warm-up (pretest) bank generator.

Five choice-only questions on the topic's objectives, tagged easy, medium or hard, so the app can
pick three by bracketing (start medium, up after a confident right answer, down after a wrong or
guessed one). The bank is stored as the topic's `topic_quizzes` row with kind 'warmup', replacing
the one before. It is not a quiz set: queries that list quiz sets filter on kind.
"""
import json
import logging
from datetime import UTC, datetime
from typing import Dict, List

from app.db.connection import UTC_NOW, execute_in_transaction
from app.services.content_generator.context import (
    NoSourceMaterialError,
    attach_sources,
    content_messages,
    fetch_concepts,
    fetch_confusable_neighbours,
    fetch_topic_context,
    format_concept_block,
    resolve_concept_ids,
)
from app.services.content_generator.quiz import minimum_usable
from app.services.content_generator.support_check import check_support
from app.services.llm.base import LLMOutputError
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import WarmupSet

logger = logging.getLogger(__name__)

WARMUP_QUESTIONS = 5
WARMUP_LEVELS = ("easy", "medium", "hard")
WARMUP_TYPES = ("multiple_choice", "true_false")

# A student who has not read yet gets the first question at medium and mostly misses, so the bank
# is deeper on the easy side than on the hard side.
WARMUP_MIX = "two easy, two medium and one hard"

WARMUP_INSTRUCTIONS = """Write {count} warm-up questions on "{topic}" from the excerpts above. The student answers some of them before reading, to find out what they already know and to prime what they are about to read.

- Ask about the objectives of the topic, one idea per question. Use only multiple_choice and true_false questions; no calculations.
- Tag each question's difficulty as easy, medium or hard. The set has {mix}. Easy questions ask for a definition or a plain fact, medium questions apply an idea to a small case, and hard questions need the idea combined with another or a common mix-up resisted.
- multiple_choice: exactly 4 options with ids A, B, C, D, one correct answer. Vary which letter is correct. Keep options short, and about the same length and level of detail: the correct one must not be the longest or the most specific.
- true_false: correct_answer is a boolean.
- Each wrong option is the answer a student would give if they held one specific wrong idea; write that idea in `misconception`. When the wrong idea is a mix-up with another concept of the <concepts> or <confusable_concepts> list, also set `confusable_concept_id` to that concept's id. The correct option has neither.
- The explanation says why the answer is right in one sentence; the student reads the material afterwards, so keep it short.
- Set `mode` to recall on every question.
- List in source_excerpts the index of every excerpt a question is based on.
{concepts}"""


def _usable_bank(questions: List[Dict]) -> List[Dict]:
    """Choice-only questions with a difficulty of easy, medium or hard. A question without one
    is kept as medium. The bank has at most WARMUP_QUESTIONS, aiming at the mix the prompt asks
    for so that every level the bracketing can reach is there, ordered easy, medium, hard."""
    bank: List[Dict] = []
    for question in questions:
        if question["question_type"] not in WARMUP_TYPES:
            continue
        level = str(question.get("difficulty") or "").strip().lower()
        question["difficulty"] = level if level in WARMUP_LEVELS else "medium"
        bank.append(question)
    wanted = {"easy": 2, "medium": 2, "hard": 1}
    chosen: List[Dict] = []
    for level in WARMUP_LEVELS:
        chosen += [q for q in bank if q["difficulty"] == level][: wanted[level]]
    # Too few of a level: fill from what is left, in the order the model wrote it.
    chosen += [q for q in bank if not any(q is c for c in chosen)][: WARMUP_QUESTIONS - len(chosen)]
    chosen.sort(key=lambda q: WARMUP_LEVELS.index(q["difficulty"]))
    return chosen


async def generate_warmup(topic_id: str) -> Dict:
    """Generate the topic's warm-up bank and store it as `topic_quizzes kind='warmup'`.

    Raises NoSourceMaterialError for a topic without excerpts and LLMOutputError when fewer than
    three usable questions come back (a wrong option without a misconception drops its question).
    """
    context = await fetch_topic_context(topic_id)
    chunks = context.chunks
    if not chunks:
        raise NoSourceMaterialError(f"No source material is mapped to topic {topic_id}")
    concepts = await fetch_concepts(topic_id)
    neighbours = await fetch_confusable_neighbours(topic_id)

    instructions = WARMUP_INSTRUCTIONS.format(
        count=WARMUP_QUESTIONS, topic=context.topic["name"], mix=WARMUP_MIX, concepts=format_concept_block(concepts, neighbours)
    )
    result = await LLMFactory.get_provider().generate_structured(
        content_messages(
            context.topic["name"], context.topic.get("description") or "", chunks, instructions,
            course_map=context.course_map,
        ),
        WarmupSet,
        max_tokens=8000,
        purpose="warmup",
    )
    supported, dropped = await check_support(
        [q for q in result.usable() if q["question_type"] in WARMUP_TYPES], chunks
    )
    questions = _usable_bank(supported)
    if len(questions) < minimum_usable(WARMUP_QUESTIONS):
        raise LLMOutputError(
            f"Warm-up had {len(questions)} usable questions of {WARMUP_QUESTIONS} requested"
        )
    resolve_concept_ids(questions, concepts, chunks, neighbours)
    attach_sources(questions, chunks)

    async def write(conn) -> str:
        await conn.execute("DELETE FROM topic_quizzes WHERE topic_id = $1 AND kind = 'warmup'", topic_id)
        return await conn.fetchval(
            f"""
            INSERT INTO topic_quizzes (id, topic_id, questions, kind, created_at)
            VALUES (gen_random_uuid()::text, $1, $2::jsonb, 'warmup', {UTC_NOW})
            RETURNING id
            """,
            topic_id,
            json.dumps(questions),
        )

    warmup_id = await execute_in_transaction(write)
    logger.info("Warm-up for topic %s: %s questions", topic_id, len(questions))
    return {
        "warmup_id": warmup_id,
        "questions": questions,
        "total_questions": len(questions),
        "dropped_unsupported": dropped,
        "generated_at": datetime.now(UTC).isoformat(),
    }
