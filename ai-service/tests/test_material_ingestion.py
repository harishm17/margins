"""Reading uploads, validating them, and the validate/chunk job handlers.

Storage is a temp folder; the job handlers run against the test Postgres (see conftest.py).
"""
import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services.document_processor.storage import StorageError, local_copy
from app.services.document_processor.validator import material_role, validate_material
from app.services.llm import LLMFactory
from app.services.llm.base import LLMError
from app.services.llm.schemas import MaterialCheck
from tests.db_helpers import get_job, seed_job, seed_material, seed_project, seed_user
from tests.document_fixtures import PdfBuilder, sentences


@pytest.fixture(autouse=True)
def local_uploads(monkeypatch, tmp_path):
    """Production settings, no bucket, uploads under tmp_path (the case that used to break)."""
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "ENABLE_PROCESSING", True)
    monkeypatch.setattr(settings, "LOCAL_UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(settings, "AUTO_EXTRACT_TOPICS_ON_CHUNK", False)
    return uploads


@pytest.fixture(autouse=True)
def accepting_llm(monkeypatch):
    class Provider:
        async def generate_structured(self, *args, **kwargs):
            return MaterialCheck(is_valid=True, notes="Looks like lecture notes.")

    monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: Provider()))


def put_upload(uploads: Path, name: str, builder: PdfBuilder) -> str:
    """Save a PDF where the frontend would, and return the local:// path it records."""
    target = uploads / "user" / "project" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    builder.save(target)
    return f"local://user/project/{name}"


def text_pdf(pages: int = 3) -> PdfBuilder:
    pdf = PdfBuilder()
    for index in range(pages):
        if index:
            pdf.new_page()
        pdf.heading(f"Section {index + 1} Overview", 16)
        for sentence in sentences(4, f"Page{index + 1}"):
            pdf.paragraph(sentence)
    return pdf


class TestStorage:
    async def test_local_path_is_read_from_the_local_uploads_folder(self, local_uploads):
        stored = put_upload(local_uploads, "a.pdf", text_pdf(1))

        async with local_copy(stored) as path:
            assert Path(path).is_file()
            assert Path(path) == (local_uploads / "user/project/a.pdf").resolve()
        # A local upload is read in place and must survive the context manager.
        assert Path(path).is_file()

    @pytest.mark.parametrize("stored", ["local://../secret.pdf"])
    async def test_path_cannot_leave_the_uploads_folder(self, tmp_path, local_uploads, stored):
        (tmp_path / "secret.pdf").write_bytes(b"x")

        with pytest.raises(StorageError):
            async with local_copy(stored):
                pass

@pytest.fixture
def s3_bucket(monkeypatch):
    """A mocked S3 bucket the storage module talks to through boto3."""
    import boto3
    from moto import mock_aws

    monkeypatch.setattr(settings, "S3_ENDPOINT", "")
    monkeypatch.setattr(settings, "S3_REGION", "us-east-1")
    monkeypatch.setattr(settings, "S3_ACCESS_KEY_ID", "test")
    monkeypatch.setattr(settings, "S3_SECRET_ACCESS_KEY", "test")
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="materials")
        yield client


class TestS3Storage:
    async def test_object_is_downloaded_and_the_copy_removed_afterwards(self, s3_bucket, tmp_path):
        source = tmp_path / "notes.pdf"
        text_pdf(2).save(source)
        s3_bucket.upload_file(str(source), "materials", "user/project/materials/m1/notes.pdf")

        async with local_copy("s3://materials/user/project/materials/m1/notes.pdf") as path:
            assert path.endswith(".pdf")
            assert Path(path).read_bytes() == source.read_bytes()
        assert not Path(path).exists()
        assert not Path(path).parent.exists()

class TestValidation:
    async def test_local_pdf_validates_in_production(self, local_uploads):
        gcs_path = put_upload(local_uploads, "ok.pdf", text_pdf())

        result = await validate_material("m1", gcs_path, "ok.pdf", "lecture_notes")

        assert result.status == "valid"
        assert result.page_count == 3
        assert "Looks like lecture notes." in result.notes

    async def test_scanned_pdf_is_rejected(self, local_uploads):
        pdf = PdfBuilder().image_page()
        for _ in range(3):
            pdf.new_page().image_page()
        gcs_path = put_upload(local_uploads, "scan.pdf", pdf)

        result = await validate_material("m1", gcs_path, "scan.pdf", "lecture_notes")

        assert result.status == "invalid"
        assert "scanned" in result.notes
        assert "OCR is not supported yet" in result.notes

@pytest.fixture
def dispatched(monkeypatch):
    """Job dispatches the handlers ask for (nothing is sent anywhere)."""
    sent = []

    async def enqueue(job_id, *args):
        sent.append((job_id, *args))

    monkeypatch.setattr(jobs, "enqueue_chunking_job", enqueue)
    monkeypatch.setattr(jobs, "enqueue_topic_extraction_job", enqueue)
    return sent


class Setup:
    """A user, project, material and the job that works on it."""

    def __init__(self, pool):
        self.pool = pool

    @classmethod
    async def create(cls, pool, job_type, gcs_path, filename="doc.pdf", status="pending"):
        self = cls(pool)
        self.user_id = await seed_user(pool)
        self.project_id = await seed_project(pool, self.user_id)
        self.material_id = await seed_material(pool, self.project_id, gcs_path, filename, status)
        self.job_id = await seed_job(
            pool, self.user_id, job_type, project_id=self.project_id,
            input_data={"materialId": self.material_id},
        )
        return self

    @property
    def payload(self) -> JobPayload:
        return JobPayload(jobId=self.job_id, jobType="", data={"materialId": self.material_id})

    async def job(self):
        return await get_job(self.pool, self.job_id)

    async def material(self):
        return await self.pool.fetchrow("SELECT * FROM materials WHERE id = $1", self.material_id)


class TestValidateJob:
    async def test_storage_error_fails_the_job_as_retryable_and_leaves_the_material(self, db):
        s = await Setup.create(db, "validate_material", "gs://b/u/p/gone.pdf", "gone.pdf")

        with pytest.raises(HTTPException) as raised:
            await jobs.validate_material_job(s.payload)

        assert raised.value.status_code == 500
        job = await s.job()
        # Back in pending for the dispatcher's retry.
        assert (job["status"], job["error_code"], job["retryable"]) == (
            "pending", "STORAGE_UNAVAILABLE", True,
        )
        assert (await s.material())["validation_status"] == "pending"

    async def test_corrupt_file_marks_the_material_invalid_and_starts_no_chunking(
        self, db, local_uploads, dispatched
    ):
        target = local_uploads / "u" / "p" / "bad.pdf"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"junk")
        s = await Setup.create(db, "validate_material", "gs://b/u/p/bad.pdf", "bad.pdf")

        result = await jobs.validate_material_job(s.payload)

        assert result["status"] == "success"
        material = await s.material()
        assert material["validation_status"] == "invalid"
        assert material["validation_notes"] == "This file could not be read. It may be corrupt."
        assert (await s.job())["status"] == "completed"
        assert dispatched == []

    async def test_file_over_a_parse_limit_is_invalid_with_a_fixed_note(
        self, db, local_uploads, dispatched, monkeypatch
    ):
        monkeypatch.setattr(settings, "PARSE_MAX_PDF_PAGES", 2)
        gcs_path = put_upload(local_uploads, "long.pdf", text_pdf(3))
        s = await Setup.create(db, "validate_material", gcs_path, "long.pdf")

        await jobs.validate_material_job(s.payload)

        material = await s.material()
        assert material["validation_status"] == "invalid"
        assert material["validation_notes"] == (
            "This file has more pages than Margins can read (limit 2)."
        )
        assert dispatched == []

    async def test_valid_file_completes_and_starts_one_chunking_job(
        self, db, local_uploads, dispatched
    ):
        gcs_path = put_upload(local_uploads, "ok.pdf", text_pdf(3))
        s = await Setup.create(db, "validate_material", gcs_path, "ok.pdf")

        await jobs.validate_material_job(s.payload)

        assert (await s.material())["validation_status"] == "valid"
        chunk_jobs = await db.fetch("SELECT * FROM processing_jobs WHERE job_type = 'chunk_material'")
        assert len(chunk_jobs) == 1
        assert chunk_jobs[0]["status"] == "pending"
        assert chunk_jobs[0]["project_id"] == s.project_id
        assert chunk_jobs[0]["target_key"] == f"chunk:{s.material_id}"
        assert [d[0] for d in dispatched] == [chunk_jobs[0]["id"]]


class TestMaterialRole:
    """A material's role (content, syllabus, exam, other) comes from the category the student
    chose for a syllabus or past exam, otherwise from what the validator says the file is."""

    @pytest.mark.parametrize(
        "category, kind, role",
        [
            ("lecture_notes", "syllabus", "syllabus"),
            ("lecture_notes", "nonsense", "content"),
            ("sample_exams", "syllabus", "exam"),
            ("syllabus", "exam", "syllabus"),
        ],
    )
    def test_the_rule(self, category, kind, role):
        assert material_role(category, kind) == role

    async def validate(self, db, local_uploads, monkeypatch, category, kind):
        class Provider:
            async def generate_structured(self, messages, schema, **kwargs):
                self.prompt = messages[0].content
                return MaterialCheck(is_valid=True, notes="ok", kind=kind)

        provider = Provider()
        monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: provider))
        gcs_path = put_upload(local_uploads, "ok.pdf", text_pdf(3))
        s = await Setup.create(db, "validate_material", gcs_path, "ok.pdf")
        await db.execute("UPDATE materials SET category = $2 WHERE id = $1", s.material_id, category)
        await jobs.validate_material_job(s.payload)
        return await s.material(), provider

    async def test_the_validators_kind_sets_the_role(self, db, local_uploads, monkeypatch, dispatched):
        material, provider = await self.validate(db, local_uploads, monkeypatch, "lecture_notes", "syllabus")
        assert material["role"] == "syllabus" and material["validation_status"] == "valid"

    async def test_without_a_model_the_role_is_content(self, db, local_uploads, monkeypatch, dispatched):
        class Down:
            async def generate_structured(self, *args, **kwargs):
                raise LLMError("no key")

        monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: Down()))
        gcs_path = put_upload(local_uploads, "ok.pdf", text_pdf(3))
        s = await Setup.create(db, "validate_material", gcs_path, "ok.pdf")

        await jobs.validate_material_job(s.payload)

        assert (await s.material())["role"] == "content"


class TestChunkJob:
    @staticmethod
    def fake_embeddings(monkeypatch):
        async def embed(texts):
            return [[0.5] * 384 for _ in texts]

        monkeypatch.setattr(jobs, "generate_embeddings", embed)

    @pytest.fixture
    async def setup(self, db, local_uploads, monkeypatch):
        gcs_path = put_upload(local_uploads, "doc.pdf", text_pdf(3))
        self.fake_embeddings(monkeypatch)
        return await Setup.create(db, "chunk_material", gcs_path, "doc.pdf", status="valid")

    async def test_headings_are_embedded_with_the_text_but_not_stored_in_it(self, setup, db, monkeypatch):
        embedded: list[str] = []

        async def embed(texts):
            embedded.extend(texts)
            return [[0.5] * 384 for _ in texts]

        monkeypatch.setattr(jobs, "generate_embeddings", embed)

        await jobs.chunk_material_job(setup.payload)

        rows = await db.fetch(
            "SELECT chunk_text, section_hierarchy FROM material_chunks WHERE material_id = $1 "
            "ORDER BY chunk_index",
            setup.material_id,
        )
        headed = [r for r in rows if r["section_hierarchy"]]
        assert headed, "the fixture PDF has headings"
        assert len(embedded) == len(rows)
        for row, text in zip(rows, embedded):
            assert text.endswith(row["chunk_text"])
            if row["section_hierarchy"]:
                assert text.startswith(row["section_hierarchy"] + "\n\n")
                assert not row["chunk_text"].startswith(row["section_hierarchy"] + "\n\n")

    async def test_chunks_are_stored_in_order_with_their_vectors(self, setup, db):
        result = await jobs.chunk_material_job(setup.payload)

        assert result["status"] == "success"
        rows = await db.fetch(
            "SELECT chunk_index, page_start, chunk_embedding::text AS vec FROM material_chunks "
            "WHERE material_id = $1 ORDER BY chunk_index",
            setup.material_id,
        )
        assert len(rows) >= 3
        assert [r["chunk_index"] for r in rows] == list(range(len(rows)))
        assert rows[0]["page_start"] == 1
        assert rows[0]["vec"].startswith("[0.5,")
        job = await setup.job()
        assert job["status"] == "completed"
        assert json.loads(job["result_data"])["chunks_created"] == len(rows)

    async def test_embedding_failure_fails_the_job_and_stores_nothing(self, setup, db, monkeypatch):
        async def broken(texts):
            raise RuntimeError("embedding model failed to load")

        monkeypatch.setattr(jobs, "generate_embeddings", broken)

        with pytest.raises(HTTPException) as raised:
            await jobs.chunk_material_job(setup.payload)

        assert raised.value.status_code == 500
        assert await db.fetchval("SELECT count(*) FROM material_chunks") == 0
        job = await setup.job()
        assert (job["status"], job["retryable"]) == ("pending", True)

    async def test_file_without_text_is_a_permanent_failure_and_marks_the_material_invalid(
        self, db, local_uploads, monkeypatch
    ):
        gcs_path = put_upload(local_uploads, "blank.pdf", PdfBuilder().image_page())
        self.fake_embeddings(monkeypatch)
        s = await Setup.create(db, "chunk_material", gcs_path, "blank.pdf", status="valid")

        with pytest.raises(HTTPException) as raised:
            await jobs.chunk_material_job(s.payload)

        assert raised.value.status_code == 400
        assert await db.fetchval("SELECT count(*) FROM material_chunks") == 0
        assert (await s.material())["validation_status"] == "invalid"
        job = await s.job()
        assert (job["error_code"], job["retryable"]) == ("NO_CONTENT", False)

    @pytest.mark.parametrize(
        "limit,value,note",
        [
            ("PARSE_MAX_PDF_PAGES", 2, "This file has more pages than Margins can read (limit 2)."),
            ("PARSE_MAX_CHUNKS", 1, "This file has more text than Margins can read."),
        ],
    )
    async def test_refused_or_unreadable_file_is_invalid_and_never_retried(
        self, db, local_uploads, monkeypatch, limit, value, note
    ):
        monkeypatch.setattr(settings, limit, value)
        gcs_path = put_upload(local_uploads, "doc.pdf", text_pdf(3))
        self.fake_embeddings(monkeypatch)
        s = await Setup.create(db, "chunk_material", gcs_path, "doc.pdf", status="valid")

        with pytest.raises(HTTPException) as raised:
            await jobs.chunk_material_job(s.payload)

        assert raised.value.status_code == 400
        assert await db.fetchval("SELECT count(*) FROM material_chunks") == 0
        material = await s.material()
        assert (material["validation_status"], material["validation_notes"]) == ("invalid", note)
        job = await s.job()
        assert (job["status"], job["retryable"]) == ("failed", False)

    async def test_unreadable_file_is_invalid_and_never_retried(self, db, local_uploads, monkeypatch):
        bad = local_uploads / "user" / "project" / "bad.pdf"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_bytes(b"junk")
        self.fake_embeddings(monkeypatch)
        s = await Setup.create(db, "chunk_material", "local://user/project/bad.pdf", "bad.pdf", status="valid")

        with pytest.raises(HTTPException) as raised:
            await jobs.chunk_material_job(s.payload)

        assert raised.value.status_code == 400
        material = await s.material()
        assert material["validation_status"] == "invalid"
        assert material["validation_notes"] == "This file could not be read. It may be corrupt."
        assert (await s.job())["retryable"] is False

    async def test_many_chunks_are_embedded_and_stored_in_batches(self, db, local_uploads, monkeypatch):
        gcs_path = put_upload(local_uploads, "doc.pdf", text_pdf(3))
        sizes: list[int] = []

        async def embed(texts):
            sizes.append(len(texts))
            return [[0.5] * 384 for _ in texts]

        monkeypatch.setattr(jobs, "generate_embeddings", embed)
        monkeypatch.setattr(jobs, "EMBED_BATCH_SIZE", 2)
        monkeypatch.setattr(jobs, "INSERT_BATCH_SIZE", 2)
        s = await Setup.create(db, "chunk_material", gcs_path, "doc.pdf", status="valid")

        await jobs.chunk_material_job(s.payload)

        stored = await db.fetchval("SELECT count(*) FROM material_chunks")
        assert stored == sum(sizes) and max(sizes) == 2 and stored > 2


class TestAutoTopicExtraction:
    @pytest.fixture(autouse=True)
    def auto_extract(self, monkeypatch, db, local_uploads):
        monkeypatch.setattr(settings, "AUTO_EXTRACT_TOPICS_ON_CHUNK", True)
        monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")

        async def embed(texts):
            return [[0.5] * 384 for _ in texts]

        monkeypatch.setattr(jobs, "generate_embeddings", embed)

    @staticmethod
    async def extraction_jobs(db):
        return await db.fetch("SELECT * FROM processing_jobs WHERE job_type = 'extract_topics'")

    async def test_extraction_waits_for_uploads_still_being_validated(
        self, db, local_uploads, dispatched
    ):
        path = put_upload(local_uploads, "doc.pdf", text_pdf(3))
        a = await Setup.create(db, "chunk_material", path, "doc.pdf", status="valid")
        b_material = await seed_material(db, a.project_id, path, "doc.pdf", "pending")

        await jobs.chunk_material_job(a.payload)
        assert await self.extraction_jobs(db) == []

        # Once the other file is validated (invalid here) and nothing is in flight, the next
        # chunk job to finish starts extraction.
        await db.execute("UPDATE materials SET validation_status = 'invalid' WHERE id = $1", b_material)
        second = await seed_job(
            db, a.user_id, "chunk_material", project_id=a.project_id,
            input_data={"materialId": a.material_id},
        )
        await jobs.chunk_material_job(
            JobPayload(jobId=second, jobType="", data={"materialId": a.material_id})
        )

        (extraction,) = await self.extraction_jobs(db)
        assert extraction["target_key"] == f"extract:{a.project_id}"
        assert dispatched == [(extraction["id"], a.project_id)]

    async def test_simultaneous_starts_create_a_single_extraction_job(
        self, db, local_uploads, dispatched
    ):
        path = put_upload(local_uploads, "doc.pdf", text_pdf(3))
        a = await Setup.create(db, "chunk_material", path, "doc.pdf", status="valid")
        await jobs.chunk_material_job(a.payload)
        await db.execute("DELETE FROM processing_jobs WHERE job_type = 'extract_topics'")
        dispatched.clear()

        await asyncio.gather(
            *[jobs._start_topic_extraction(a.project_id, a.user_id) for _ in range(5)]
        )

        assert len(await self.extraction_jobs(db)) == 1
        assert len(dispatched) == 1
