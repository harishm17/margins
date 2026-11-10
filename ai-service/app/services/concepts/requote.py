"""Give a concept that lost all its claims new ones from the topic's remaining files, keeping its id (F0).

Deleting a file removes the claims whose quotes came from it. A concept left with no claim cannot be recalled, quizzed
or pointed at, but it carries the student's history, its edges and the items tagged with its id, so it must not be
re-created. `extract_concepts` would re-create it (store.py replaces the graph and keeps a concept only when the new
graph has one of the same name). Here the model gets the concepts that exist, with their names and summaries, and is
asked for quotes only; the quotes are checked by the same code that checks an extraction's (validate.validate_claims)
and written to the concepts by id.

Behind CLAIM_REQUOTE, off by default. Off, `requote_concepts` returns without a model call.
"""
import logging
from dataclasses import dataclass, field
from html import escape
from typing import Any, Dict, List

from app.config import settings
from app.db.connection import execute_query
from app.services.concepts.extractor import EXTRACTION_SYSTEM_PROMPT, format_excerpts
from app.services.concepts.store import store_requoted_claims
from app.services.concepts.validate import normalize, validate_claims
from app.services.content_generator.context import NoSourceMaterialError, fetch_topic_context
from app.services.llm.base import LLMMessage
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import ConceptRequote, ExtractedClaim

logger = logging.getLogger(__name__)

# Concepts asked for in one call; a topic has at most 8 (extractor.MAX_CONCEPTS), but a student can add their own.
MAX_CONCEPTS_PER_CALL = 20

REQUOTE_INSTRUCTIONS = """These concepts of the topic exist already but have lost their claims, because the file their quotes came from was removed. Find new claims for them in the excerpts above.

For each concept in <concepts_to_requote> that the excerpts support, give 2 to 5 claims:
- text: one thing a student who knows the concept can state, in your own words.
- quote: the supporting words copied from one excerpt exactly, character for character, at most 300 characters. A quote that is not in the excerpt is discarded, so copy rather than paraphrase.
- chunk_id: the excerpt the quote comes from.
- concept_key: the concept's id, exactly as given.

Do not rename, merge or add concepts. When no excerpt supports a concept, give it no claims."""


@dataclass
class RequotePlan:
    """What the model offered for a topic's claimless concepts, after validation. Nothing is written."""

    topic_id: str
    concepts: List[Dict[str, Any]] = field(default_factory=list)  # id, name, summary
    claims: List[ExtractedClaim] = field(default_factory=list)  # concept_key is the concept id
    dropped_claims: int = 0
    skipped: str = ""  # why no model call was made, when none was


@dataclass
class RequoteSummary:
    topic_id: str
    concepts_without_claims: int = 0
    concepts_requoted: int = 0
    claims: int = 0
    dropped_claims: int = 0
    skipped: str = ""

    def as_result(self) -> Dict[str, Any]:
        return {
            "topic_id": self.topic_id,
            "concepts_without_claims": self.concepts_without_claims,
            "concepts_requoted": self.concepts_requoted,
            "claims": self.claims,
            "dropped_claims": self.dropped_claims,
            "skipped": self.skipped,
        }


async def concepts_without_claims(topic_id: str) -> List[Dict[str, Any]]:
    """The topic's active concepts that have no claim (id, name, summary), in the order of the topic."""
    rows = await execute_query(
        """
        SELECT id, name, summary FROM concepts c
        WHERE topic_id = $1 AND status = 'active' AND origin = 'llm'
          AND NOT EXISTS (SELECT 1 FROM concept_claims k WHERE k.concept_id = c.id)
        ORDER BY order_index, id
        """,
        topic_id,
    )
    return [dict(row) for row in rows]


def format_concepts(concepts: List[Dict[str, Any]]) -> str:
    lines = [
        f'<concept id="{concept["id"]}">{escape(concept["name"], quote=False)}: {escape(concept["summary"], quote=False)}</concept>'
        for concept in concepts
    ]
    return "<concepts_to_requote>\n" + "\n".join(lines) + "\n</concepts_to_requote>"


async def estimate_prompt_tokens(topic_id: str) -> int:
    """A rough input size of the re-quote call for a topic (characters over 4), for a cost estimate before any spend."""
    concepts = await concepts_without_claims(topic_id)
    if not concepts:
        return 0
    context = await fetch_topic_context(topic_id)
    chunks = [chunk for chunk in context.chunks if chunk.get("source_kind") != "supporting"]
    if not chunks:
        return 0
    text = format_excerpts(context.topic, chunks, context.course_map) + format_concepts(concepts) + REQUOTE_INSTRUCTIONS
    return len(text) // 4


async def propose_quotes(topic_id: str) -> RequotePlan:
    """Ask the model for quotes for the topic's claimless concepts and validate them. Makes at most one model call, and
    none when there is nothing to do or no source to quote. Raises LLM errors as the extraction does."""
    plan = RequotePlan(topic_id=topic_id)
    plan.concepts = (await concepts_without_claims(topic_id))[:MAX_CONCEPTS_PER_CALL]
    if not plan.concepts:
        plan.skipped = "no concept lacks claims"
        return plan
    try:
        context = await fetch_topic_context(topic_id)
    except NoSourceMaterialError:
        plan.skipped = "no source material"
        return plan
    # Quotes come from what the topic is taught from, as an extraction's do.
    chunks = [chunk for chunk in context.chunks if chunk.get("source_kind") != "supporting"]
    if not chunks:
        plan.skipped = "no source material"
        return plan

    raw = await LLMFactory.get_provider().generate_structured(
        [
            LLMMessage(role="system", content=EXTRACTION_SYSTEM_PROMPT),
            LLMMessage(role="user", content=format_excerpts(context.topic, chunks, context.course_map)),
            LLMMessage(role="user", content=format_concepts(plan.concepts) + "\n\n" + REQUOTE_INSTRUCTIONS),
        ],
        ConceptRequote,
        max_tokens=16000,
        purpose="requote_concepts",
    )
    plan.claims, plan.dropped_claims = validate_claims(
        raw.claims,
        {concept["id"] for concept in plan.concepts},
        {chunk["id"]: normalize(str(chunk.get("chunk_text") or "")) for chunk in chunks},
    )
    return plan


async def requote_concepts(topic_id: str) -> RequoteSummary:
    """Re-quote the topic's claimless concepts and write the claims. Raises LookupError for an unknown topic."""
    summary = RequoteSummary(topic_id=topic_id)
    if not settings.CLAIM_REQUOTE:
        summary.skipped = "CLAIM_REQUOTE is off"
        return summary
    plan = await propose_quotes(topic_id)
    summary.concepts_without_claims = len(plan.concepts)
    summary.dropped_claims = plan.dropped_claims
    summary.skipped = plan.skipped
    if plan.claims:
        written = await store_requoted_claims(topic_id, plan.claims)
        summary.concepts_requoted = len(written)
        summary.claims = sum(written.values())
    left = summary.concepts_without_claims - summary.concepts_requoted
    if left:
        logger.info("Topic %s: %s concepts still have no claims after the re-quote", topic_id, left)
    return summary
