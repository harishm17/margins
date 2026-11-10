"""Which chunks a topic is generated from: the stored mappings, and keeping them current.

Topic extraction maps each topic to its best chunks and freezes them in
`topic_chunk_mappings`. Two cases leave a topic with the wrong mappings:

- A topic added by hand during review has none (extraction never saw it).
- A file uploaded after extraction adds chunks the topic's mappings predate.

`ensure_topic_mappings` runs before a generator reads the mappings and recomputes them in
both cases, with the same retrieval as extraction.
"""
import logging
from typing import Dict, List

from app.db.connection import UTC_NOW, execute_in_transaction, execute_one
from app.services.embeddings.search import hybrid_search_chunks

logger = logging.getLogger(__name__)

_TOPIC_STATE_SQL = """
    SELECT
        t.id,
        t.project_id,
        t.name,
        t.description,
        t.keywords,
        (SELECT COUNT(*) FROM topic_chunk_mappings WHERE topic_id = t.id) AS mapping_count,
        (SELECT MAX(created_at) FROM topic_chunk_mappings WHERE topic_id = t.id) AS mapped_at,
        (
            SELECT MAX(mc.created_at)
            FROM material_chunks mc
            JOIN materials m ON mc.material_id = m.id
            WHERE m.project_id = t.project_id AND m.validation_status = 'valid'
              AND m.role NOT IN ('syllabus', 'exam')
        ) AS newest_chunk_at
    FROM topics t
    WHERE t.id = $1
"""


async def replace_topic_mappings(conn, topic_id: str, chunks: List[Dict]) -> None:
    """Make `chunks` (best first, from `hybrid_search_chunks`) the topic's mappings."""
    # Two concurrent remaps of one topic take turns instead of interleaving delete and insert.
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", f"topic-mappings:{topic_id}")
    await conn.execute("DELETE FROM topic_chunk_mappings WHERE topic_id = $1", topic_id)
    await conn.executemany(
        f"""
        INSERT INTO topic_chunk_mappings
        (id, topic_id, chunk_id, relevance_score, relevance_source, created_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, {UTC_NOW})
        ON CONFLICT (topic_id, chunk_id) DO UPDATE
        SET relevance_score = EXCLUDED.relevance_score
        """,
        [
            (topic_id, chunk["id"], chunk["relevance_score"], chunk["relevance_source"])
            for chunk in chunks
        ],
    )


async def ensure_topic_mappings(topic_id: str, limit: int) -> None:
    """Recompute a topic's mappings when it has none or a newer chunk exists in its project.

    Does nothing for a topic whose mappings are at least as new as every chunk. If the topic
    has older mappings and retrieval fails (the embedder is down, say), those are kept.
    Retrieval that finds nothing above the similarity floor leaves the topic with no
    mappings, and the generator reports that there is no source material.
    """
    topic = await execute_one(_TOPIC_STATE_SQL, topic_id)
    if topic is None:
        return

    has_mappings = topic["mapping_count"] > 0
    stale = (
        has_mappings
        and topic["newest_chunk_at"] is not None
        and topic["mapped_at"] < topic["newest_chunk_at"]
    )
    if has_mappings and not stale:
        return

    logger.info(
        "Mapping topic %s to chunks: %s",
        topic_id,
        "mappings are older than the newest chunk" if stale else "no mappings yet",
    )
    try:
        chunks = await hybrid_search_chunks(
            topic["project_id"],
            topic["name"],
            topic["description"] or "",
            list(topic["keywords"] or []),
            limit=limit,
        )
    except Exception as exc:
        if not has_mappings:
            raise
        logger.warning("Could not refresh stale mappings of topic %s, keeping them: %s", topic_id, exc)
        return

    async def replace(conn):
        await replace_topic_mappings(conn, topic_id, chunks)

    await execute_in_transaction(replace)
    logger.info("Topic %s now maps to %s chunks", topic_id, len(chunks))
