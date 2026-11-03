"""Stand-in for the topic context (excerpts, course map) so generator tests need no database."""
from contextlib import ExitStack, contextmanager
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from app.services.content_generator.context import TopicContext

GENERATOR_MODULES = (
    "app.services.content_generator.notes",
    "app.services.content_generator.examples",
    "app.services.content_generator.quiz",
    "app.services.exam_generator",
    "app.services.content_generator.warmup",
)


def topic_context(chunks: List[Dict[str, Any]], course_map: str = "", **topic: Any) -> TopicContext:
    return TopicContext(
        topic={"id": "t1", "project_id": "p1", "name": topic.get("name", "T"), "description": "d", "keywords": [],
               "objectives": topic.get("objectives", []), "prerequisite_ids": []},
        chunks=chunks,
        course_map=course_map,
        primary_count=len(chunks),
    )


@contextmanager
def stub_topic_context(chunks: List[Dict[str, Any]], course_map: str = "", digest: str = "",
                       context: Optional[TopicContext] = None,
                       contexts: Optional[Dict[str, TopicContext]] = None,
                       concepts: Optional[List[Dict[str, Any]]] = None,
                       neighbours: Optional[List[Dict[str, Any]]] = None):
    """Every generator reads `chunks` (and `course_map`) instead of the database, and the quiz and
    exam generators see `digest` as what the student already has. `contexts` maps a topic id to its
    own context (a prerequisite, say); any other id gets the main one. `concepts` are the topic's
    concepts (none by default: a topic whose extraction has not run); `neighbours` are the confusable
    concepts of other topics (none by default)."""
    result = context or topic_context(chunks, course_map)

    async def fetch(topic_id: str, limit: int = 24) -> TopicContext:
        return (contexts or {}).get(topic_id, result)

    async def existing(topic_id: str) -> str:
        return digest

    async def fetch_concepts(topic_id: str) -> List[Dict[str, Any]]:
        return [dict(concept) for concept in concepts or []]

    async def fetch_neighbours(topic_id: str) -> List[Dict[str, Any]]:
        return [dict(concept) for concept in neighbours or []]

    with ExitStack() as stack:
        for module in GENERATOR_MODULES:
            stack.enter_context(patch(f"{module}.fetch_topic_context", fetch))
            stack.enter_context(patch(f"{module}.fetch_concepts", fetch_concepts, create=True))
            stack.enter_context(patch(f"{module}.fetch_confusable_neighbours", fetch_neighbours, create=True))
        for module in ("app.services.content_generator.quiz", "app.services.exam_generator"):
            stack.enter_context(patch(f"{module}.existing_content_digest", existing))
        yield result
