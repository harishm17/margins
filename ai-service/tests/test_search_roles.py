"""Syllabus and past-exam files stay out of topic mapping and generation retrieval, not out of chat."""
import pytest

from app.services.embeddings import search
from tests.db_helpers import add_chunk, seed_material, seed_project, seed_user, unit


@pytest.fixture(autouse=True)
def query_is_e0(monkeypatch):
    async def embed(text):
        return unit(1.0)

    monkeypatch.setattr(search, "generate_query_embedding", embed)


@pytest.fixture
async def files(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    ids = {}
    for role in ("content", "syllabus", "exam", "other"):
        material = await seed_material(db, project_id, filename=f"{role}.pdf", status="valid", role=role)
        ids[role] = (material, await add_chunk(db, material, 0, f"krebs cycle in the {role} file", unit(1.0, 0.1)))
    return project_id, ids


async def test_topic_search_skips_syllabus_and_exam_files_by_default(db, files):
    project_id, ids = files

    found = await search.hybrid_search_chunks(project_id, "Krebs cycle", "", [], limit=10)

    assert {c["filename"] for c in found} == {"content.pdf", "other.pdf"}


async def test_the_roles_to_skip_can_be_chosen(db, files):
    project_id, ids = files

    only_content = await search.hybrid_search_chunks(
        project_id, "Krebs cycle", "", [], limit=10, exclude_roles=("syllabus", "exam", "other")
    )
    everything = await search.hybrid_search_chunks(project_id, "Krebs cycle", "", [], limit=10, exclude_roles=())

    assert {c["filename"] for c in only_content} == {"content.pdf"}
    assert len(everything) == 4


async def test_full_text_only_search_applies_the_same_filter(db, files, monkeypatch):
    project_id, _ = files

    async def broken(text):
        raise RuntimeError("embedder down")

    monkeypatch.setattr(search, "generate_query_embedding", broken)

    found = await search.hybrid_search_chunks(project_id, "krebs cycle", "", ["krebs"], limit=10)

    assert {c["filename"] for c in found} == {"content.pdf", "other.pdf"}


async def test_chat_can_still_find_every_file(db, files):
    project_id, _ = files

    found = await search.search_chunks_for_question(project_id, "what is the krebs cycle", limit=10, min_similarity=0.5)

    assert {c["filename"] for c in found} == {"content.pdf", "syllabus.pdf", "exam.pdf", "other.pdf"}


async def test_the_chunk_rows_carry_what_a_context_needs(db, files):
    project_id, _ = files

    chunk = (await search.hybrid_search_chunks(project_id, "Krebs cycle", "", [], limit=1))[0]

    for key in ("id", "chunk_text", "page_start", "chunk_index", "token_count", "material_id", "filename", "category"):
        assert key in chunk
