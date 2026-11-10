"""Finding the chunks of a project that explain a topic.

Two searches over the project's valid materials, fused by rank:

1. Vector leg: cosine similarity between the topic's query embedding and the chunk
   embeddings (HNSW index on `material_chunks.chunk_embedding`).
2. Full-text leg: Postgres full-text search over `material_chunks.search_vector` (heading
   path weighted above body text) for the topic name and keywords, ordered by `ts_rank_cd`.

Reciprocal Rank Fusion (RRF) combines them: a chunk scores 1 / (RRF_K + rank) in each leg it
appears in, and the scores add. Only ranks are used, so cosine similarity and `ts_rank_cd`
never have to be put on one scale. A chunk whose vector similarity is below
MIN_SIMILARITY is dropped from both legs, so a topic the materials barely cover returns a
short list (or nothing) instead of 24 loosely related chunks.
"""
import logging
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from app.db.connection import execute_in_transaction, execute_query
from app.services.embeddings.generator import generate_query_embedding

logger = logging.getLogger(__name__)

# Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper; a larger
# value flattens the difference between rank 1 and rank 10.
RRF_K = 60

# Candidates taken from each leg before fusion.
CANDIDATE_POOL = 50

# Cosine similarity below which a chunk is not offered for a topic. On the eval corpus
# (bge-small, heading-prefixed vectors) chunks that explain a topic score 0.67 and up for a
# full topic query and 0.54 and up for a bare name; half of the other chunks score under 0.55.
# The model compresses scores, so the floor removes clearly unrelated chunks, not near misses.
MIN_SIMILARITY = 0.55

# Whether the materials cover a topic at all, decided before any chunk is kept. bge-small
# gives even gibberish a best match around 0.67, so the per-chunk floor above cannot reject
# an off-topic topic. Measured on the eval corpus (38 topics, each as a full query and as a
# bare name, plus 10 off-topic names): real topics have a best similarity of 0.677 or more,
# and 0.725 or more when nothing matches in full text; off-topic ones top out at 0.61-0.676
# with at most one full-text hit. A topic is covered when its best chunk reaches
# COVERED_SIMILARITY, or COVERED_SIMILARITY_WITH_TEXT_MATCH with at least one full-text match.
# Set between the two groups, leaning towards keeping a topic.
COVERED_SIMILARITY = 0.70
COVERED_SIMILARITY_WITH_TEXT_MATCH = 0.65

# Keywords beyond this many are ignored by the full-text leg.
MAX_FULLTEXT_PHRASES = 12

# Relevance sources, as stored in topic_chunk_mappings.relevance_source.
SOURCE_FULLTEXT = "keyword_match"
SOURCE_VECTOR = "semantic_search"
SOURCE_BOTH = "keyword_and_semantic"

# Roles whose files are not course content: left out of topic mapping and generation retrieval
# (chat searches every valid file).
NON_CONTENT_ROLES = ("syllabus", "exam")


def _material_filter(first_param: int, exclude_roles: Sequence[str], exclude_material_ids: Sequence[str]):
    """(SQL, args) that keep chunks of files with another role and not in the given files.
    Parameters are numbered from `first_param`; the SQL is empty when nothing is excluded."""
    clauses: List[str] = []
    args: List = []
    if exclude_roles:
        args.append(list(exclude_roles))
        clauses.append(f"AND m.role <> ALL(${first_param + len(args) - 1}::text[])")
    if exclude_material_ids:
        args.append([str(material_id) for material_id in exclude_material_ids])
        clauses.append(f"AND m.id <> ALL(${first_param + len(args) - 1}::text[])")
    return "\n          ".join(clauses), args


_CHUNK_COLUMNS = """
    mc.id,
    mc.chunk_text,
    mc.section_hierarchy,
    mc.page_start,
    mc.page_end,
    mc.chunk_index,
    mc.token_count,
    m.id AS material_id,
    m.filename,
    m.category,
    m.uploaded_at AS material_uploaded_at
"""


def topic_query_text(topic_name: str, topic_description: str, keywords: Sequence[str]) -> str:
    """The text embedded as the topic's query: name, description and keywords."""
    text = f"{topic_name}: {topic_description or ''}".strip()
    keyword_list = [kw.strip() for kw in keywords or [] if kw and kw.strip()]
    if keyword_list:
        text += f" Keywords: {', '.join(keyword_list)}"
    return text


def fulltext_phrases(topic_name: str, keywords: Iterable[str]) -> List[str]:
    """The phrases the full-text leg looks for: the topic name and each keyword.

    A chunk matches when it contains any one phrase; the words inside one phrase must all
    be present (after English stemming and stop-word removal).
    """
    phrases: List[str] = []
    seen = set()
    for raw in [topic_name, *(keywords or [])]:
        phrase = re.sub(r"\s+", " ", (raw or "")).strip()
        key = phrase.lower()
        if phrase and key not in seen:
            seen.add(key)
            phrases.append(phrase)
    return phrases[:MAX_FULLTEXT_PHRASES]


def fulltext_query_sql(phrase_count: int, first_param: int) -> str:
    """SQL for a tsquery that ORs one `websearch_to_tsquery` per phrase.

    Phrases are bound as parameters `$first_param`, `$first_param + 1`, ...; they never
    become part of the SQL text. `websearch_to_tsquery` does not raise on odd input
    (quotes, operators, symbols), unlike `to_tsquery`.
    """
    if phrase_count < 1:
        raise ValueError("at least one phrase is needed")
    return " || ".join(
        f"websearch_to_tsquery('english', ${first_param + index})" for index in range(phrase_count)
    )


def _vector_literal(values: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def course_place(chunk: Dict) -> Tuple:
    """A chunk's place in the course: its file's upload order (the file's id after that), then its position in the file.
    The order the service reads chunks in elsewhere (ORDER BY m.uploaded_at, m.id, mc.chunk_index). Equal scores are
    broken by it, so the same materials and question give the same excerpts in the same order every time; a chunk's
    own id, random, comes last."""
    uploaded = chunk.get("material_uploaded_at")
    index = chunk.get("chunk_index")
    return (uploaded is None, uploaded, str(chunk.get("material_id") or ""), index is None, index, str(chunk["id"]))


def _rank_key(chunk: Dict) -> Tuple:
    """Best first: the fused score, then the vector similarity, then course order."""
    similarity = chunk["similarity"] if chunk.get("similarity") is not None else -1.0
    return (-chunk["relevance_score"], -similarity, course_place(chunk))


def _text_key(chunk: Dict) -> str:
    return re.sub(r"\s+", " ", str(chunk.get("chunk_text") or "")).strip().lower()


def fuse_rankings(
    vector_rows: Sequence[Dict],
    fulltext_rows: Sequence[Dict],
    limit: int,
    *,
    rrf_k: int,
    min_similarity: Optional[float],
) -> List[Dict]:
    """Fuse two ranked lists with Reciprocal Rank Fusion. Pure; no database.

    Each list is best first and holds chunk dicts with an `id` and a `similarity` (None for a
    chunk with no embedding). Chunks with a similarity below `min_similarity` are dropped
    before ranks are assigned, so junk does not use up rank positions. A chunk without an
    embedding can only come from the full-text leg and is kept.

    Returns up to `limit` chunks, best first, each with `relevance_score` (the RRF score) and
    `relevance_source`. Chunks with identical text (the same file uploaded twice) appear once.
    """

    def eligible(rows: Sequence[Dict]) -> List[Dict]:
        return [
            row
            for row in rows
            if min_similarity is None
            or row.get("similarity") is None
            or row["similarity"] >= min_similarity
        ]

    fused: Dict[str, Dict] = {}
    for rows, source in ((eligible(vector_rows), SOURCE_VECTOR), (eligible(fulltext_rows), SOURCE_FULLTEXT)):
        for rank, row in enumerate(rows, start=1):
            chunk_id = str(row["id"])
            entry = fused.get(chunk_id)
            if entry is None:
                entry = fused[chunk_id] = {**row, "relevance_score": 0.0, "relevance_source": source}
            elif entry["relevance_source"] != source:
                entry["relevance_source"] = SOURCE_BOTH
            entry["relevance_score"] += 1.0 / (rrf_k + rank)
            if entry.get("similarity") is None and row.get("similarity") is not None:
                entry["similarity"] = row["similarity"]

    ranked = sorted(fused.values(), key=_rank_key)

    result: List[Dict] = []
    seen_text = set()
    for chunk in ranked:
        key = _text_key(chunk)
        if key and key in seen_text:
            continue
        seen_text.add(key)
        result.append(chunk)
        if len(result) == limit:
            break
    return result


async def _vector_leg(
    project_id: str,
    query_embedding: Sequence[float],
    pool_size: int,
    exclude_roles: Sequence[str] = (),
    exclude_material_ids: Sequence[str] = (),
) -> List[Dict]:
    """Nearest chunks of the project's valid materials by cosine similarity."""
    filter_sql, filter_args = _material_filter(4, exclude_roles, exclude_material_ids)
    sql = f"""
        SELECT {_CHUNK_COLUMNS},
               1 - (mc.chunk_embedding <=> $1::vector) AS similarity
        FROM material_chunks mc
        JOIN materials m ON mc.material_id = m.id
        WHERE m.project_id = $2
          AND m.validation_status = 'valid'
          AND mc.chunk_embedding IS NOT NULL
          {filter_sql}
        ORDER BY mc.chunk_embedding <=> $1::vector
        LIMIT $3
    """

    async def run(conn):
        # An HNSW scan returns at most hnsw.ef_search (default 40) rows, and the project
        # filter is applied to what it returns, so the setting must cover the pool.
        await conn.execute("SELECT set_config('hnsw.ef_search', $1, true)", str(max(pool_size, 40)))
        # pgvector 0.8+ keeps scanning the index until the filter has produced enough rows;
        # older versions do not have the setting.
        try:
            async with conn.transaction():
                await conn.execute("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)")
        except Exception:
            pass
        return await conn.fetch(sql, _vector_literal(query_embedding), project_id, pool_size, *filter_args)

    # The index scan's order is approximate ("relaxed_order") and has no tie-break: closest first, ties in course order.
    rows = [dict(row) for row in await execute_in_transaction(run)]
    return sorted(rows, key=lambda row: (-row["similarity"], course_place(row)))


async def _fulltext_leg(
    project_id: str,
    phrases: Sequence[str],
    query_embedding: Optional[Sequence[float]],
    pool_size: int,
    exclude_roles: Sequence[str] = (),
    exclude_material_ids: Sequence[str] = (),
) -> List[Dict]:
    """Chunks matching any phrase, best `ts_rank_cd` first. Carries the vector similarity too."""
    if not phrases:
        return []
    # $1 is the project; $2 is the query vector when there is one; the phrases follow.
    params: List = [project_id]
    if query_embedding is not None:
        params.append(_vector_literal(query_embedding))
        similarity = (
            "CASE WHEN mc.chunk_embedding IS NULL THEN NULL "
            "ELSE 1 - (mc.chunk_embedding <=> $2::vector) END"
        )
    else:
        similarity = "NULL::float8"
    tsquery = fulltext_query_sql(len(phrases), first_param=len(params) + 1)
    params.extend(phrases)
    filter_sql, filter_args = _material_filter(len(params) + 1, exclude_roles, exclude_material_ids)
    params.extend(filter_args)
    sql = f"""
        WITH q AS (SELECT {tsquery} AS query)
        SELECT {_CHUNK_COLUMNS},
               {similarity} AS similarity,
               ts_rank_cd(mc.search_vector, q.query) AS text_rank
        FROM material_chunks mc
        JOIN materials m ON mc.material_id = m.id
        CROSS JOIN q
        WHERE m.project_id = $1
          AND m.validation_status = 'valid'
          AND mc.search_vector @@ q.query
          {filter_sql}
        ORDER BY text_rank DESC, m.uploaded_at, m.id, mc.chunk_index
        LIMIT {int(pool_size)}
    """
    rows = await execute_query(sql, *params)
    return [dict(row) for row in rows]


def topic_is_covered(vector_rows: Sequence[Dict], fulltext_rows: Sequence[Dict]) -> bool:
    """Whether the best chunks are close enough to say the materials cover the topic."""
    best = max((float(row["similarity"]) for row in vector_rows if row.get("similarity") is not None), default=0.0)
    if best >= COVERED_SIMILARITY:
        return True
    return bool(fulltext_rows) and best >= COVERED_SIMILARITY_WITH_TEXT_MATCH


async def hybrid_search_chunks(
    project_id: str,
    topic_name: str,
    topic_description: str,
    keywords: List[str],
    limit: int = 20,
    exclude_roles: Sequence[str] = NON_CONTENT_ROLES,
    exclude_material_ids: Sequence[str] = (),
) -> List[Dict]:
    """The chunks of a project that best explain a topic, best first.

    Chunks of syllabus and past-exam files are never offered (`exclude_roles`), nor are those of
    `exclude_material_ids` (the supporting search skips the files a topic is taught from).

    Runs the vector and full-text legs over the project's valid materials, fuses them with
    RRF and applies the similarity floor (see the module docstring). Returns at most `limit`
    chunk dicts (id, chunk_text, section_hierarchy, page_start, page_end, chunk_index,
    material_id, filename, similarity, relevance_score, relevance_source). The list is empty
    when nothing in the project is related to the topic.

    If the query cannot be embedded, falls back to the full-text leg alone.
    """
    logger.info("Searching project %s for a topic", project_id)

    query_embedding: Optional[List[float]] = None
    try:
        query_embedding = await generate_query_embedding(
            topic_query_text(topic_name, topic_description, keywords)
        )
    except Exception as exc:
        logger.warning("Could not embed a topic (%s); using full-text search only", exc)

    vector_rows: List[Dict] = []
    if query_embedding is not None:
        vector_rows = await _vector_leg(
            project_id, query_embedding, CANDIDATE_POOL, exclude_roles, exclude_material_ids
        )
    fulltext_rows = await _fulltext_leg(
        project_id,
        fulltext_phrases(topic_name, keywords),
        query_embedding,
        CANDIDATE_POOL,
        exclude_roles,
        exclude_material_ids,
    )

    # Judged only when chunks have vectors: right after a model change, before re-embedding,
    # full text is all there is.
    if vector_rows and not topic_is_covered(vector_rows, fulltext_rows):
        logger.info("A topic is not covered by project %s's materials", project_id)
        return []

    chunks = fuse_rankings(
        vector_rows,
        fulltext_rows,
        limit,
        rrf_k=RRF_K,
        min_similarity=MIN_SIMILARITY if query_embedding is not None else None,
    )
    logger.info(
        "Topic search in project %s: %s vector and %s full-text candidates, %s chunks kept",
        project_id,
        len(vector_rows),
        len(fulltext_rows),
        len(chunks),
    )
    return chunks


# Words of a question that the full-text leg looks for, beyond the question itself.
_QUESTION_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'_-]{3,}")


def question_phrases(question: str) -> List[str]:
    """The phrases the full-text leg uses for a free-form question.

    The whole question comes first (all of its words must match, so it only hits a chunk that
    answers it closely), then its longest distinct words one by one, since a chunk that
    contains any of them can be relevant. English stop words drop out in Postgres.
    """
    collapsed = re.sub(r"\s+", " ", question or "").strip()
    if not collapsed:
        return []
    words: List[str] = []
    seen = set()
    for word in _QUESTION_WORD.findall(collapsed):
        key = word.lower()
        if key not in seen:
            seen.add(key)
            words.append(word)
    longest_first = sorted(words, key=len, reverse=True)[: MAX_FULLTEXT_PHRASES - 1]
    kept = set(longest_first)
    return [collapsed, *(word for word in words if word in kept)]


def boost_chunks(chunks: Sequence[Dict], boosted_ids: Iterable[str], factor: float) -> List[Dict]:
    """Multiply the score of the chunks in `boosted_ids` by `factor` and re-sort. Pure."""
    boosted = {str(chunk_id) for chunk_id in boosted_ids}
    rescored = [
        {**chunk, "relevance_score": chunk["relevance_score"] * (factor if str(chunk["id"]) in boosted else 1.0)}
        for chunk in chunks
    ]
    return sorted(rescored, key=_rank_key)


async def search_chunks_for_question(
    project_id: str,
    question: str,
    limit: int = 12,
    min_similarity: float = MIN_SIMILARITY,
    topic_chunk_ids: Optional[Iterable[str]] = None,
    topic_boost: float = 1.5,
) -> List[Dict]:
    """The chunks of a project that best answer a question, best first.

    Same two legs and fusion as `hybrid_search_chunks`, but the query is the question as
    asked and the similarity floor is the caller's. With `topic_chunk_ids` (the chunks mapped
    to a topic) those chunks' scores are multiplied by `topic_boost` before the cut to
    `limit`. Empty when nothing clears the floor.
    """
    query_embedding: Optional[List[float]] = None
    try:
        query_embedding = await generate_query_embedding(question)
    except Exception as exc:
        logger.warning("Could not embed the question (%s); using full-text search only", exc)

    vector_rows: List[Dict] = []
    if query_embedding is not None:
        vector_rows = await _vector_leg(project_id, query_embedding, CANDIDATE_POOL)
    fulltext_rows = await _fulltext_leg(
        project_id, question_phrases(question), query_embedding, CANDIDATE_POOL
    )

    boosted = list(topic_chunk_ids or [])
    chunks = fuse_rankings(
        vector_rows,
        fulltext_rows,
        limit * 2 if boosted else limit,
        rrf_k=RRF_K,
        min_similarity=min_similarity if query_embedding is not None else None,
    )
    if boosted:
        chunks = boost_chunks(chunks, boosted, topic_boost)[:limit]
    logger.info(
        "Question search: %s vector and %s full-text candidates, %s chunks kept",
        len(vector_rows),
        len(fulltext_rows),
        len(chunks),
    )
    return chunks
