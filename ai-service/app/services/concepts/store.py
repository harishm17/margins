"""Writing a validated concept graph, and tagging a topic's existing items with its concepts."""
import json
import logging
import math
import re
from typing import Any, Dict, List, Optional

from app.db.connection import UTC_NOW, execute_in_transaction, execute_one, execute_query, execute_update
from app.services.concepts.validate import ValidatedGraph
from app.services.llm.schemas import ExtractedClaim
from app.services.concepts.vectors import parse_vector, vector_literal
from app.services.embeddings.generator import generate_embeddings

logger = logging.getLogger(__name__)

# Cosine similarity at which an item's `concepts_tested` string counts as a concept.
LEGACY_MATCH_THRESHOLD = 0.75

# Stored next to the topic's content: what the reader and Recall show for each objective.
PROMPTS_CONTENT_TYPE = "concept_prompts"


def _name_key(name: str) -> str:
    return re.sub(r"\s+", " ", name or "").strip().lower()


def concept_embedding_text(name: str, summary: str) -> str:
    return f"{name} — {summary}"


async def _insert_claims(conn, claims: List[ExtractedClaim], ids: Dict[str, str]) -> int:
    """Write `claims` for the concepts in `ids` (claim.concept_key -> concept id), numbered per concept in the order
    given, each with the file and pages of its chunk. A claim whose chunk was rewritten meanwhile is skipped. Returns
    how many were written."""
    places = {
        row["id"]: row
        for row in await conn.fetch(
            "SELECT id, material_id, page_start, page_end FROM material_chunks WHERE id = ANY($1::text[])",
            sorted({claim.chunk_id for claim in claims}),
        )
    }
    counts: Dict[str, int] = {}
    written = 0
    for claim in claims:
        place = places.get(claim.chunk_id)
        concept_id = ids.get(claim.concept_key)
        if place is None or concept_id is None:
            continue  # the chunk was rewritten while the model was working
        order = counts.get(concept_id, 0)
        counts[concept_id] = order + 1
        await conn.execute(
            """
            INSERT INTO concept_claims (id, concept_id, text, quote, material_id, chunk_id,
                                        page_start, page_end, order_index)
            VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8)
            """,
            concept_id, claim.text, claim.quote, place["material_id"], claim.chunk_id,
            place["page_start"], place["page_end"], order,
        )
        written += 1
    return written


async def store_requoted_claims(topic_id: str, claims: List[ExtractedClaim]) -> Dict[str, int]:
    """Give claims to concepts of the topic that have none (claim.concept_key is the concept's id), in one transaction.

    The concepts keep their ids, so the student's history, edges and tagged items stay attached. A concept that has
    claims by the time the rows are locked (another job gave it some) is left alone. Returns concept id -> claims
    written, for the concepts that got any."""

    async def write(conn) -> Dict[str, int]:
        rows = await conn.fetch(
            """
            SELECT id FROM concepts
            WHERE topic_id = $1 AND status = 'active' AND origin = 'llm' AND id = ANY($2::text[])
              AND NOT EXISTS (SELECT 1 FROM concept_claims k WHERE k.concept_id = concepts.id)
            ORDER BY id FOR UPDATE
            """,
            topic_id, sorted({claim.concept_key for claim in claims}),
        )
        ids = {row["id"]: row["id"] for row in rows}
        wanted = [claim for claim in claims if claim.concept_key in ids]
        await _insert_claims(conn, wanted, ids)
        return {
            row["concept_id"]: row["n"]
            for row in await conn.fetch(
                "SELECT concept_id, COUNT(*) AS n FROM concept_claims WHERE concept_id = ANY($1::text[]) GROUP BY concept_id",
                list(ids),
            )
        }

    return await execute_in_transaction(write)


async def store_graph(topic_id: str, graph: ValidatedGraph) -> int:
    """Replace the topic's graph with `graph`, in one transaction.

    The topic's `llm` concepts that have no evidence are deleted (their claims and edges go with
    them) and written again. A concept with evidence stays, so the student's history keeps its
    meaning: when the new graph has a concept of the same name it is updated in place and gets
    the new claims, otherwise it is left as it was. Concepts a student wrote are not touched.
    Returns how many concepts were kept because of their evidence.
    """
    topic = await execute_one("SELECT project_id FROM topics WHERE id = $1", topic_id)
    if topic is None:
        raise LookupError(f"Topic {topic_id} not found")
    project_id = topic["project_id"]

    vectors = await generate_embeddings(
        [concept_embedding_text(concept.name, concept.summary) for concept in graph.concepts]
    )

    async def write(conn) -> int:
        # An answer being written takes a share lock on its concept's row (the foreign key). Locking the rows first, in
        # one order, makes this wait for such a write to commit; the delete below is a new statement and so sees the
        # event it wrote, instead of deleting a concept (and, by cascade, its evidence) on a snapshot from before it.
        await conn.fetch(
            "SELECT id FROM concepts WHERE topic_id = $1 AND origin = 'llm' ORDER BY id FOR UPDATE",
            topic_id,
        )
        await conn.execute(
            """
            DELETE FROM concepts
            WHERE topic_id = $1 AND origin = 'llm'
              AND NOT EXISTS (SELECT 1 FROM evidence_events e WHERE e.concept_id = concepts.id)
            """,
            topic_id,
        )
        remaining = await conn.fetch(
            "SELECT id, name, origin FROM concepts WHERE topic_id = $1 AND status = 'active'", topic_id
        )
        reusable = {_name_key(row["name"]): row["id"] for row in remaining if row["origin"] == "llm"}
        kept = len([row for row in remaining if row["origin"] == "llm"])

        ids: Dict[str, str] = {}  # local key -> concept id
        for position, (concept, vector) in enumerate(zip(graph.concepts, vectors)):
            existing = reusable.pop(_name_key(concept.name), None)
            if existing:
                await conn.execute(
                    """
                    UPDATE concepts SET summary = $2, kind = $3, order_index = $4, objective_indexes = $5,
                                        difficulty_prior = $6, embedding = $7::vector
                    WHERE id = $1
                    """,
                    existing, concept.summary, concept.kind, position, concept.objective_indexes,
                    concept.difficulty, vector_literal(vector),
                )
                await conn.execute("DELETE FROM concept_claims WHERE concept_id = $1", existing)
                ids[concept.key] = existing
                continue
            ids[concept.key] = await conn.fetchval(
                f"""
                INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index,
                                      objective_indexes, difficulty_prior, status, origin, embedding, created_at)
                VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, 'active', 'llm', $9::vector, {UTC_NOW})
                RETURNING id
                """,
                project_id, topic_id, concept.name, concept.summary, concept.kind, position,
                concept.objective_indexes, concept.difficulty, vector_literal(vector),
            )

        # Edges the extraction proposed for the concepts it is about to rewrite go first. Edges
        # from later topics to this one's concepts, and the ones a student made, stay.
        own = list(ids.values())
        await conn.execute(
            """
            DELETE FROM concept_edges
            WHERE origin = 'llm' AND status = 'proposed'
              AND ((source_id = ANY($1::text[]) AND target_id = ANY($1::text[]))
                   OR (target_id = ANY($1::text[]) AND type IN ('prerequisite', 'encompasses')
                       AND source_id IN (SELECT id FROM concepts WHERE topic_id <> $2)))
            """,
            own, topic_id,
        )

        await _insert_claims(conn, graph.claims, ids)

        for edge in graph.edges:
            source, target = ids.get(edge.source, edge.source), ids.get(edge.target, edge.target)
            if edge.type == "confusable" and source > target:
                # The validator ordered the pair by local key; the stored rule is by real id.
                source, target = target, source
            await conn.execute(
                f"""
                INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence,
                                           origin, status, evidence_quote, created_at)
                SELECT gen_random_uuid()::text, $1::text, $2::text, $3::text, $4::text, $5::float8, $6::float8, 'llm', 'proposed', $7::text, {UTC_NOW}
                WHERE EXISTS (SELECT 1 FROM concepts WHERE id = $2) AND EXISTS (SELECT 1 FROM concepts WHERE id = $3)
                ON CONFLICT (source_id, target_id, type) DO NOTHING
                """,
                project_id, source, target, edge.type, edge.weight, edge.confidence, edge.evidence_quote,
            )

        await conn.execute(
            f"""
            INSERT INTO topic_content (id, topic_id, content_type, content_data, metadata, created_at, updated_at)
            VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, NULL, {UTC_NOW}, {UTC_NOW})
            ON CONFLICT (topic_id, content_type)
            DO UPDATE SET content_data = EXCLUDED.content_data, updated_at = {UTC_NOW}
            """,
            topic_id,
            PROMPTS_CONTENT_TYPE,
            json.dumps({
                "focus_questions": [q.model_dump() for q in graph.focus_questions],
                "recall_prompts": [p.model_dump() for p in graph.recall_prompts],
            }),
        )
        return kept

    return await execute_in_transaction(write)


def _json_value(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _cosine(a: List[float], b: List[float]) -> float:
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b)) / norm if norm else 0.0


def _needs_mapping(item: Any, active_ids: set) -> bool:
    """An item that has no concept ids, or only ids of concepts that no longer exist."""
    if not isinstance(item, dict):
        return False
    ids = item.get("concept_ids")
    return not (isinstance(ids, list) and any(i in active_ids for i in ids))


async def map_legacy_items(topic_id: str) -> int:
    """Write `concept_ids` into the topic's stored quiz questions and example and practice
    problems that predate concepts, by cosine similarity of their `concepts_tested` or
    `key_concepts` strings to the concept embeddings (at least LEGACY_MATCH_THRESHOLD).
    Closest concept first. Items that already point at live concepts, and items that match
    nothing, are left alone. Returns how many items were tagged."""
    rows = await execute_query(
        "SELECT id, embedding::text AS embedding FROM concepts "
        "WHERE topic_id = $1 AND status = 'active' AND embedding IS NOT NULL ORDER BY order_index, id",
        topic_id,
    )
    if not rows:
        return 0
    concepts = [(row["id"], parse_vector(row["embedding"])) for row in rows]
    active_ids = {concept_id for concept_id, _ in concepts}

    # All kinds on purpose: warm-up rows are tagged here too.
    quizzes = await execute_query("SELECT id, questions FROM topic_quizzes WHERE topic_id = $1", topic_id)
    contents = await execute_query(
        "SELECT id, content_data FROM topic_content "
        "WHERE topic_id = $1 AND content_type IN ('solved_examples', 'interactive_examples')",
        topic_id,
    )
    quiz_items = [(row["id"], _json_value(row["questions"]), "concepts_tested") for row in quizzes]
    content_items = [(row["id"], _json_value(row["content_data"]), "key_concepts") for row in contents]

    strings = sorted({
        str(text).strip()
        for _, items, field in quiz_items + content_items
        if isinstance(items, list)
        for item in items
        if _needs_mapping(item, active_ids)
        for text in (item.get(field) or [])
        if str(text).strip()
    })
    if not strings:
        return 0
    vectors = dict(zip(strings, await generate_embeddings(strings)))

    def concept_ids_for(item: dict, field: str) -> List[str]:
        best: Dict[str, float] = {}
        for text in item.get(field) or []:
            vector = vectors.get(str(text).strip())
            if vector is None:
                continue
            for concept_id, concept_vector in concepts:
                score = _cosine(vector, concept_vector)
                if score >= LEGACY_MATCH_THRESHOLD and score > best.get(concept_id, 0.0):
                    best[concept_id] = score
        return [concept_id for concept_id, _ in sorted(best.items(), key=lambda pair: -pair[1])]

    tagged = 0
    for table, column, group in (
        ("topic_quizzes", "questions", quiz_items),
        ("topic_content", "content_data", content_items),
    ):
        for row_id, items, field in group:
            if not isinstance(items, list):
                continue
            changed = False
            for item in items:
                if not _needs_mapping(item, active_ids):
                    continue
                ids = concept_ids_for(item, field)
                if ids:
                    item["concept_ids"] = ids
                    changed = True
                    tagged += 1
            if changed:
                await execute_update(f"UPDATE {table} SET {column} = $1::jsonb WHERE id = $2", json.dumps(items), row_id)
    return tagged
