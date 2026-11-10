"""Topic retrieval: rank fusion, the similarity floor, query building, and the SQL legs."""
import pytest

from app.services.embeddings import search
from app.services.embeddings.search import (
    SOURCE_BOTH,
    SOURCE_FULLTEXT,
    SOURCE_VECTOR,
    boost_chunks,
    fulltext_phrases,
    fulltext_query_sql,
    fuse_rankings,
    hybrid_search_chunks,
    topic_is_covered,
    topic_query_text,
)
from tests.db_helpers import add_chunk, seed_material, seed_project, seed_user, unit

K = 60


def row(chunk_id, similarity=0.8, text=None):
    return {"id": chunk_id, "similarity": similarity, "chunk_text": text or f"text of {chunk_id}"}


def fuse(vector, fulltext, limit=24, min_similarity=0.5):
    return fuse_rankings(vector, fulltext, limit, rrf_k=K, min_similarity=min_similarity)


class TestFuseRankings:
    def test_score_is_the_sum_of_reciprocal_ranks(self):
        result = fuse([row("a"), row("b")], [row("b"), row("c")])
        scores = {c["id"]: c["relevance_score"] for c in result}
        assert scores["a"] == pytest.approx(1 / (K + 1))
        assert scores["b"] == pytest.approx(1 / (K + 2) + 1 / (K + 1))
        assert scores["c"] == pytest.approx(1 / (K + 2))

    def test_a_chunk_found_by_both_legs_beats_the_top_of_either_leg(self):
        result = fuse([row("v1"), row("both")], [row("t1"), row("x"), row("both")])
        assert [c["id"] for c in result][0] == "both"
        assert result[0]["relevance_source"] == SOURCE_BOTH

    def test_sources_name_the_leg(self):
        result = {c["id"]: c["relevance_source"] for c in fuse([row("v")], [row("t")])}
        assert result == {"v": SOURCE_VECTOR, "t": SOURCE_FULLTEXT}

    def test_equal_scores_break_by_similarity_then_id(self):
        result = fuse([row("a", 0.6)], [row("b", 0.9)])
        assert [c["id"] for c in result] == ["b", "a"]
        result = fuse([row("z", 0.7)], [row("y", 0.7)])
        assert [c["id"] for c in result] == ["y", "z"]

    def test_scores_are_not_flat(self):
        """The old scoring gave half of all results the same score."""
        result = fuse([row(f"v{i}") for i in range(10)], [row(f"v{i}") for i in range(5, 15)])
        scores = [c["relevance_score"] for c in result]
        assert len(set(scores)) >= len(scores) - 5  # only the two-leg mirror ranks may tie in pairs
        assert scores == sorted(scores, reverse=True)


class TestSimilarityFloor:
    def test_low_similarity_chunks_are_dropped_from_both_legs(self):
        result = fuse([row("v", 0.9), row("vlow", 0.3)], [row("tlow", 0.2), row("t", 0.7)])
        assert {c["id"] for c in result} == {"v", "t"}

    def test_a_topic_that_matches_little_returns_a_short_list(self):
        assert fuse([row(f"c{i}", 0.4) for i in range(30)], [row("t", 0.45)]) == []

    def test_dropped_chunks_do_not_take_rank_positions(self):
        result = fuse([row("junk", 0.1), row("good", 0.9)], [])
        assert result[0]["relevance_score"] == pytest.approx(1 / (K + 1))

    def test_floor_is_inclusive(self):
        assert [c["id"] for c in fuse([row("edge", 0.5)], [])] == ["edge"]

    def test_chunk_without_an_embedding_is_kept_when_text_matches(self):
        result = fuse([], [row("no-vector", None)])
        assert [c["id"] for c in result] == ["no-vector"]

    def test_no_floor_when_none(self):
        assert len(fuse([row("a", 0.01)], [], min_similarity=None)) == 1


class TestDedupe:
    def test_same_chunk_in_both_legs_appears_once(self):
        result = fuse([row("a")], [row("a")])
        assert [c["id"] for c in result] == ["a"]

    def test_identical_text_from_another_material_appears_once(self):
        result = fuse(
            [row("first", 0.9, "Same   text"), row("second", 0.8, "same text"), row("other", 0.7)], []
        )
        assert [c["id"] for c in result] == ["first", "other"]

    def test_limit_counts_unique_chunks(self):
        rows = [row("a", 0.9, "x"), row("b", 0.8, "x"), row("c", 0.7, "y"), row("d", 0.6, "z")]
        assert [c["id"] for c in fuse(rows, [], limit=3)] == ["a", "c", "d"]


class TestQueryBuilding:
    def test_embedded_query_has_name_description_and_keywords(self):
        text = topic_query_text("Operant conditioning", "Learning from consequences.", ["reinforcement", " punishment "])
        assert text == "Operant conditioning: Learning from consequences. Keywords: reinforcement, punishment"

    def test_embedded_query_for_a_bare_name(self):
        assert topic_query_text("Hashing", "", []) == "Hashing:"

    def test_phrases_are_name_then_keywords_without_repeats(self):
        assert fulltext_phrases("Hash tables", ["hashing", "Hash Tables", "  collision   chaining ", ""]) == [
            "Hash tables",
            "hashing",
            "collision chaining",
        ]

    def test_phrases_are_capped(self):
        assert len(fulltext_phrases("t", [f"k{i}" for i in range(40)])) == search.MAX_FULLTEXT_PHRASES

    def test_phrase_text_never_enters_the_sql(self):
        sql = fulltext_query_sql(len(fulltext_phrases("x'; DROP TABLE users; --", [])), first_param=2)
        assert "DROP" not in sql

# ---- the SQL legs, on the test database --------------------------------------------------


@pytest.fixture
def query_vector(monkeypatch):
    """The topic's query embedding is always e0."""
    async def embed(text):
        return unit(1.0)

    monkeypatch.setattr(search, "generate_query_embedding", embed)


@pytest.fixture
async def project(db):
    user_id = await seed_user(db)
    return await seed_project(db, user_id)


class TestHybridSearch:
    async def test_vector_hits_rank_by_similarity(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        far = await add_chunk(db, material, 0, "unrelated words here", unit(0.6, 0.8))
        near = await add_chunk(db, material, 1, "other words there", unit(1.0, 0.1))
        mid = await add_chunk(db, material, 2, "more words again", unit(1.0, 0.8))

        result = await hybrid_search_chunks(project, "Topic", "", [], limit=10)

        assert [str(r["id"]) for r in result] == [near, mid, far]
        assert all(r["relevance_source"] == SOURCE_VECTOR for r in result)

    async def test_below_the_floor_returns_nothing(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        await add_chunk(db, material, 0, "no shared words", unit(0.0, 1.0))  # similarity 0

        assert await hybrid_search_chunks(project, "Topic", "", ["zzz"], limit=10) == []

    async def test_fulltext_hits_are_ordered_by_rank_not_chunk_index(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        same_vector = unit(1.0, 0.05)
        weak = await add_chunk(db, material, 0, "A long passage that mentions mitochondria once among many other words", same_vector)
        strong = await add_chunk(db, material, 1, "mitochondria mitochondria mitochondria", same_vector)

        rows = await search._fulltext_leg(project, ["mitochondria"], unit(1.0), 10)

        assert [str(r["id"]) for r in rows] == [strong, weak]
        assert rows[0]["text_rank"] > rows[1]["text_rank"]

    async def test_heading_matches_outrank_body_matches(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        body = await add_chunk(db, material, 0, "The glycolysis pathway splits glucose.", None, heading="Chapter 1")
        heading = await add_chunk(db, material, 1, "The pathway splits glucose.", None, heading="Chapter 1 > Glycolysis")

        rows = await search._fulltext_leg(project, ["glycolysis"], None, 10)

        assert [str(r["id"]) for r in rows] == [heading, body]

    async def test_fusion_puts_the_chunk_both_legs_like_first(self, db, project, query_vector, monkeypatch):
        monkeypatch.setattr(search, "CANDIDATE_POOL", 2)
        material = await seed_material(db, project, status="valid")
        vector_only = await add_chunk(db, material, 0, "alpha beta", unit(1.0, 0.0))
        both = await add_chunk(db, material, 1, "the krebs cycle explained", unit(1.0, 0.3))
        text_only = await add_chunk(db, material, 2, "krebs krebs krebs", unit(1.0, 0.6))

        result = await hybrid_search_chunks(project, "Krebs cycle", "", ["krebs"], limit=10)

        ids = [str(r["id"]) for r in result]
        assert set(ids) == {vector_only, both, text_only}
        by_id = {str(r["id"]): r for r in result}
        assert by_id[both]["relevance_source"] == SOURCE_BOTH
        assert by_id[text_only]["relevance_source"] == SOURCE_FULLTEXT
        assert by_id[vector_only]["relevance_source"] == SOURCE_VECTOR
        assert ids[0] == both

    async def test_text_match_below_the_floor_is_dropped(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        await add_chunk(db, material, 0, "krebs cycle in an unrelated context", unit(0.0, 1.0))

        assert await hybrid_search_chunks(project, "Krebs", "", ["krebs"], limit=10) == []

    async def test_chunk_without_a_vector_is_found_by_text(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        chunk = await add_chunk(db, material, 0, "the krebs cycle", None)

        result = await hybrid_search_chunks(project, "Krebs", "", ["krebs"], limit=10)

        assert [str(r["id"]) for r in result] == [chunk]

    async def test_other_projects_and_invalid_materials_are_not_searched(self, db, project, query_vector):
        mine = await seed_material(db, project, status="valid")
        pending = await seed_material(db, project, status="pending", filename="p.pdf")
        other_project = await seed_project(db, await seed_user(db))
        theirs = await seed_material(db, other_project, status="valid")
        expected = await add_chunk(db, mine, 0, "krebs cycle", unit(1.0))
        await add_chunk(db, pending, 0, "krebs cycle pending", unit(1.0))
        await add_chunk(db, theirs, 0, "krebs cycle theirs", unit(1.0))

        result = await hybrid_search_chunks(project, "Krebs", "", ["krebs"], limit=10)

        assert [str(r["id"]) for r in result] == [expected]

    async def test_odd_keywords_do_not_break_the_query(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        await add_chunk(db, material, 0, "c++ templates", unit(1.0))

        result = await hybrid_search_chunks(project, "C++", "", ["\"unclosed", "-x & y | (z", "a:*", "!!"], limit=10)

        assert len(result) == 1

    async def test_embedding_failure_falls_back_to_text_search(self, db, project, monkeypatch):
        async def broken(text):
            raise RuntimeError("model unavailable")

        monkeypatch.setattr(search, "generate_query_embedding", broken)
        material = await seed_material(db, project, status="valid")
        chunk = await add_chunk(db, material, 0, "the krebs cycle", unit(0.0, 1.0))

        result = await hybrid_search_chunks(project, "Krebs", "", ["krebs"], limit=10)

        assert [str(r["id"]) for r in result] == [chunk]
        assert result[0]["relevance_source"] == SOURCE_FULLTEXT


class TestCoverage:
    """Off-topic topics are rejected before any chunk is kept."""

    @pytest.mark.parametrize(
        "best,text_hits,covered",
        [
            (0.72, 0, True),   # a real topic with no full-text match (eval minimum 0.725)
            (0.68, 3, True),   # a bare custom name that also matches in full text
            (0.676, 0, False),  # gibberish and off-topic names top out here
            (0.62, 1, False),  # an off-topic name with one stray word match
        ],
    )
    def test_thresholds(self, best, text_hits, covered):
        vector_rows = [{"similarity": best}, {"similarity": best - 0.1}]
        assert topic_is_covered(vector_rows, [{}] * text_hits) is covered

    def test_no_vectors_is_not_covered(self):
        assert topic_is_covered([], [{}]) is False

    async def test_an_off_topic_name_returns_nothing(self, db, project, query_vector):
        material = await seed_material(db, project, status="valid")
        # Similar enough to pass the per-chunk floor, not enough to count as covered.
        await add_chunk(db, material, 0, "loops and functions", unit(0.66, 0.75))

        assert await hybrid_search_chunks(project, "Medieval cuisine", "", [], limit=10) == []


# ---- ties come in course order --------------------------------------------------------------

EARLIER_UPLOAD = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 day'"
# Ids that sort against course order, so a tie broken by id would put the later chunk first.
LOW_ID = "00000000000040008000000000000001"
HIGH_ID = "ffffffffffff4fffbfffffffffffffff"


def placed(chunk_id, uploaded, material, index, similarity=0.8):
    """A row with its place in the course: its file's upload time and id, and its position in the file."""
    return {**row(chunk_id, similarity), "material_uploaded_at": uploaded, "material_id": material, "chunk_index": index}


async def with_id(db, chunk_id, new_id):
    await db.execute("UPDATE material_chunks SET id = $1 WHERE id = $2", new_id, chunk_id)
    return new_id


class TestTiesInCourseOrder:
    """Equal scores come in course order (upload order, then position in the file), never in the order of random ids,
    so the same materials and question give the same excerpts in the same order every time."""

    def test_equal_fused_scores_break_by_upload_order(self):
        later = placed("0-later", 2, "m1", 0)
        earlier = placed("f-earlier", 1, "m2", 5)
        assert [c["id"] for c in fuse([later], [earlier])] == ["f-earlier", "0-later"]

    def test_within_a_file_position_breaks_the_tie(self):
        second = placed("0-second", 1, "m1", 2)
        first = placed("f-first", 1, "m1", 1)
        assert [c["id"] for c in fuse([second], [first])] == ["f-first", "0-second"]

    def test_boosting_keeps_course_order_for_equal_scores(self):
        chunks = [
            {**placed("0-later", 2, "m1", 0), "relevance_score": 0.02},
            {**placed("f-earlier", 1, "m2", 0), "relevance_score": 0.02},
        ]
        assert [c["id"] for c in boost_chunks(chunks, [], 1.5)] == ["f-earlier", "0-later"]

    async def test_full_text_ties_come_in_course_order(self, db, project, query_vector):
        first_file = await seed_material(db, project, filename="a.pdf", status="valid", uploaded_at=EARLIER_UPLOAD)
        second_file = await seed_material(db, project, filename="b.pdf", status="valid")
        later = await with_id(db, await add_chunk(db, second_file, 0, "mitochondria make energy", unit(1.0)), LOW_ID)
        earlier = await with_id(db, await add_chunk(db, first_file, 3, "mitochondria make energy", unit(1.0)), HIGH_ID)

        rows = await search._fulltext_leg(project, ["mitochondria"], unit(1.0), 10)

        assert [str(r["id"]) for r in rows] == [earlier, later]

    async def test_vector_ties_come_in_course_order(self, db, project, query_vector):
        second_file = await seed_material(db, project, filename="b.pdf", status="valid")
        first_file = await seed_material(db, project, filename="a.pdf", status="valid", uploaded_at=EARLIER_UPLOAD)
        earlier = await with_id(db, await add_chunk(db, first_file, 3, "another passage", unit(1.0, 0.2)), HIGH_ID)
        later = await with_id(db, await add_chunk(db, second_file, 0, "one passage", unit(1.0, 0.2)), LOW_ID)

        rows = await search._vector_leg(project, unit(1.0), 10)

        assert [str(r["id"]) for r in rows] == [earlier, later]
