"""Job processing endpoints.

Each endpoint is a `@job_handler` (app/services/job_runner.py): the decorator claims the job,
keeps its lease, records LLM usage and marks it completed or failed. The functions here only
do the work and return a `JobOutcome`.
"""
import asyncio
import logging
import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from app.models.jobs import JobPayload, MaterialValidationInput, ContentGenerationInput, ExamGenerationInput
from app.services.document_processor.validator import material_role, validate_material
from app.services.document_processor.chunker import chunk_document, NoContentError
from app.services.document_processor.storage import local_copy
from app.services.embeddings.generator import embedding_text, generate_embeddings
from app.services.course_planner import NoPlannableMaterialError, plan_course, write_plan
from app.services.content_generator import NotesGenerator, ExamplesGenerator, QuizGenerator
from app.services.content_generator.context import NoSourceMaterialError
from app.services.content_generator.examples import ExampleType
from app.services.content_generator.quiz import QuestionType
from app.services.exam_generator import ExamGenerator
from app.services.exam_relevance import mark_exam_relevant_topics, mark_exam_relevant_topics_quietly
from app.services.exam_style import profile_exam_material
from app.services.exam_grader import ExamGrader
from app.services.cloud_tasks import (
    enqueue_chunking_job,
    enqueue_exam_profile_job,
    enqueue_exam_relevance_job,
    enqueue_topic_extraction_job,
    mark_undelivered,
)
from app.services.generation_chain import content_exists, continue_chain, dispatch as dispatch_job, plan_next_job
from app.services.job_reaper import reap_expired_jobs
from app.services.llm.base import LLMRefusalError
from app.services.llm.limiter import topic_lock
from app.services import ai_status
from app.services.budget import over_budget_message
from app.services.job_runner import (
    DailyBudgetExceeded,
    JobContext,
    JobOutcome,
    PermanentJobError,
    classify_failure,
    create_job,
    job_handler,
    parse_input,
)
from app.db.connection import UTC_NOW, execute_one, execute_update, execute_in_transaction
from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

# Kept under its old name for callers and tests.
_classify_failure = classify_failure


def _json_value(value):
    """asyncpg returns jsonb columns as text."""
    return json.loads(value) if isinstance(value, str) else value


@router.post("/jobs/reap")
async def reap_jobs():
    """Fail expired jobs that used all their attempts and re-dispatch the others.

    The same pass runs periodically inside the service; this is for an external cron.
    """
    return await reap_expired_jobs()


@router.post("/jobs/validate-material")
@job_handler(
    job_type="validate_material",
    label="Validation",
    default_error_code="VALIDATION_FAILED",
    stage="validating",
)
async def validate_material_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Validate an uploaded file, then start chunking it."""
    input_data = parse_input(MaterialValidationInput, payload.data)

    material = await execute_one(
        """
        SELECT id, gcs_path, filename, category
        FROM materials
        WHERE id = $1
        """,
        input_data.materialId,
    )
    if not material:
        raise PermanentJobError("Material not found", "MATERIAL_NOT_FOUND")

    # A storage or network error raises here and fails the job as retryable: only the file's
    # content can make a material invalid.
    validation_result = await validate_material(
        material_id=material["id"],
        gcs_path=material["gcs_path"],
        filename=material["filename"],
        category=material["category"],
    )

    # The role is decided here, once: the student's category for a syllabus or past exam, else
    # what the validator says the file is. The student can change it afterwards.
    await execute_update(
        f"""
        UPDATE materials
        SET validation_status = $1,
            validation_notes = $2,
            role = $3,
            validated_at = {UTC_NOW}
        WHERE id = $4
        """,
        validation_result.status,
        validation_result.notes,
        material_role(material["category"], validation_result.kind),
        input_data.materialId,
    )

    # The chunking job is created before this one is marked completed, so a client that sees
    # validation finish can already find it. It is dispatched once this job is completed.
    start_chunking = None
    if validation_result.status == "valid":
        chunk_job_id, created = await create_job(
            user_id=job.user_id,
            project_id=job.project_id,
            job_type="chunk_material",
            stage="chunking",
            input_data={"materialId": input_data.materialId},
            target_key=f"chunk:{input_data.materialId}",
        )
        if created:
            async def start_chunking():
                try:
                    await enqueue_chunking_job(chunk_job_id, input_data.materialId)
                except Exception as exc:
                    logger.error("Could not dispatch chunking job %s: %s", chunk_job_id, exc)
                    await mark_undelivered(chunk_job_id, str(exc))
        else:
            logger.info("Chunking job %s already active for %s", chunk_job_id, input_data.materialId)

    return JobOutcome(
        result={
            "validation_status": validation_result.status,
            "notes": validation_result.notes,
        },
        after=start_chunking,
    )


async def _start_topic_extraction(project_id: str, user_id: str) -> None:
    """Start topic extraction once the project's uploads have all been processed.

    Called after a chunk job completes. It waits while any material is still being validated
    or has a validate/chunk job in flight; a valid material with no chunks does not block it.
    Two chunk jobs finishing together may both get here: the unique target key lets only one
    extraction job exist.
    """
    state = await execute_one(
        """
        SELECT
            NOT EXISTS (
                SELECT 1 FROM materials
                WHERE project_id = $1 AND validation_status = 'pending'
            ) AS all_validated,
            NOT EXISTS (
                SELECT 1 FROM processing_jobs
                WHERE project_id = $1
                  AND job_type IN ('validate_material', 'chunk_material')
                  AND status IN ('pending', 'processing')
            ) AS none_in_flight,
            EXISTS (
                SELECT 1 FROM material_chunks mc
                JOIN materials m ON m.id = mc.material_id
                WHERE m.project_id = $1
            ) AS has_chunks
        """,
        project_id,
    )
    if not (state["all_validated"] and state["none_in_flight"] and state["has_chunks"]):
        return

    topic_job_id, created = await create_job(
        user_id=user_id,
        project_id=project_id,
        job_type="extract_topics",
        stage="extracting",
        input_data={"projectId": project_id},
        target_key=f"extract:{project_id}",
    )
    if not created:
        logger.info("Topic extraction %s already active for project %s", topic_job_id, project_id)
        return

    logger.info("All materials processed for project %s, starting topic extraction", project_id)
    if not settings.llm_configured:
        # Fail the job here rather than letting the dispatcher retry a missing key.
        await execute_update(
            f"""
            UPDATE processing_jobs
            SET status = 'failed',
                error_code = 'LLM_NOT_CONFIGURED',
                retryable = FALSE,
                error_message = 'ANTHROPIC_API_KEY is not configured',
                completed_at = {UTC_NOW}
            WHERE id = $1
            """,
            topic_job_id,
        )
        return
    try:
        await enqueue_topic_extraction_job(topic_job_id, project_id)
    except Exception as exc:
        logger.error("Could not dispatch topic extraction %s: %s", topic_job_id, exc)
        await mark_undelivered(topic_job_id, str(exc))


@router.post("/jobs/chunk-material")
@job_handler(
    job_type="chunk_material",
    label="Chunking",
    default_error_code="CHUNKING_FAILED",
    stage="chunking",
)
async def chunk_material_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Split a validated file into chunks and embed them."""
    input_data = parse_input(MaterialValidationInput, payload.data)

    material = await execute_one(
        """
        SELECT id, gcs_path, filename, project_id
        FROM materials
        WHERE id = $1
        """,
        input_data.materialId,
    )
    if not material:
        raise PermanentJobError("Material not found (deleted)", "MATERIAL_NOT_FOUND")

    # For development without processing enabled, skip actual PDF processing
    if settings.is_development and not settings.ENABLE_PROCESSING:
        logger.info(f"[DEV] Simulating chunking for {material['filename']}")
        return JobOutcome(
            result={"chunks_created": 0, "note": "Development mode"},
            response={"dev_mode": True},
        )

    try:
        # The source file is a local copy for the length of the job; downloaded copies are
        # deleted when the block exits.
        async with local_copy(material["gcs_path"]) as local_path:
            # Parsing is blocking, so it runs in a worker thread.
            chunks = await asyncio.to_thread(chunk_document, local_path, material["filename"])
            logger.info(f"Created {len(chunks)} chunks from {material['filename']}")

            await job.set_stage("embedding", 40)
            # An embedding failure fails the job (and it is retried): chunks stored without
            # vectors would be invisible to semantic search while the job claimed success.
            # The heading path is embedded with the text; the stored chunk_text is unchanged.
            embeddings = await generate_embeddings(
                [embedding_text(chunk.section_hierarchy, chunk.chunk_text) for chunk in chunks]
            )
            if len(embeddings) != len(chunks):
                raise RuntimeError(
                    f"Embedding returned {len(embeddings)} vectors for {len(chunks)} chunks"
                )
            logger.info(f"Generated {len(embeddings)} embeddings")
    except NoContentError:
        # A file with no text to chunk is a content problem: retrying cannot help, and the
        # material must not stay "valid" with zero chunks.
        await execute_update(
            f"""
            UPDATE materials
            SET validation_status = 'invalid',
                validation_notes = $1,
                validated_at = {UTC_NOW}
            WHERE id = $2
            """,
            "No readable text could be extracted from this file.",
            input_data.materialId,
        )
        raise

    # Replace the material's chunks in one transaction, so a re-run (a retry after a crash)
    # leaves exactly one set of chunks.
    records = [
        (
            input_data.materialId,
            # PostgreSQL text cannot hold null bytes
            chunk.chunk_text.replace('\x00', ''),
            f"[{','.join(map(str, embedding))}]",
            chunk.section_hierarchy.replace('\x00', '') if chunk.section_hierarchy else None,
            chunk.page_start,
            chunk.page_end,
            chunk.chunk_index,
            chunk.token_count,
        )
        for chunk, embedding in zip(chunks, embeddings)
    ]

    async def replace_chunks_transaction(conn):
        await conn.execute(
            "DELETE FROM material_chunks WHERE material_id = $1",
            input_data.materialId,
        )
        await conn.executemany(
            f"""
            INSERT INTO material_chunks
            (id, material_id, chunk_text, chunk_embedding, section_hierarchy,
             page_start, page_end, chunk_index, token_count, created_at)
            VALUES (gen_random_uuid()::text, $1, $2, $3::vector, $4, $5, $6, $7, $8, {UTC_NOW})
            """,
            records,
        )
        return len(records)

    chunks_created = await execute_in_transaction(replace_chunks_transaction)
    logger.info(f"Stored {chunks_created} chunks in database")

    # Topic extraction stays off unless AUTO_EXTRACT_TOPICS_ON_CHUNK is set, to avoid
    # surprise topic churn while a student is still uploading files.
    project_id = material["project_id"]

    async def after():
        # A past exam gets its style profile and its topics marked once its text is stored.
        await _start_exam_jobs(input_data.materialId, project_id, job.user_id)
        if settings.AUTO_EXTRACT_TOPICS_ON_CHUNK and project_id:
            await _start_topic_extraction(project_id, job.user_id)

    return JobOutcome(result={"chunks_created": chunks_created}, after=after)


async def _start_exam_jobs(material_id: str, project_id: Optional[str], user_id: str) -> None:
    """After a file is chunked: when it is a past exam, start the job that marks the topics it
    covers and the one that writes its style profile (both need the model, so only when one is set up).
    The role is read now, not at the start of the chunk job: the student may have changed it."""
    if not project_id:
        return
    row = await execute_one("SELECT role FROM materials WHERE id = $1", material_id)
    if not row or row["role"] != "exam":
        return
    if not settings.llm_configured:
        return  # both jobs need the model
    await start_exam_relevance_job(project_id, user_id)
    job_id, created = await create_job(
        user_id=user_id,
        project_id=project_id,
        job_type="profile_exam",
        stage="extracting",
        input_data={"materialId": material_id},
        target_key=f"profile:{material_id}",
    )
    if created:
        try:
            await enqueue_exam_profile_job(job_id, material_id)
        except Exception as exc:
            logger.error("Could not dispatch exam profile job %s: %s", job_id, exc)
            await mark_undelivered(job_id, str(exc))


async def start_exam_relevance_job(project_id: str, user_id: str) -> None:
    """One exam-relevance job per project at a time."""
    job_id, created = await create_job(
        user_id=user_id,
        project_id=project_id,
        job_type="exam_relevance",
        stage="extracting",
        input_data={"projectId": project_id},
        target_key=f"exam-relevance:{project_id}",
    )
    if created:
        try:
            await enqueue_exam_relevance_job(job_id, project_id)
        except Exception as exc:
            logger.error("Could not dispatch exam relevance job %s: %s", job_id, exc)
            await mark_undelivered(job_id, str(exc))


@router.post("/jobs/profile-exam")
@job_handler(
    job_type="profile_exam",
    label="Past exam style",
    default_error_code="EXAM_PROFILE_FAILED",
    stage="extracting",
    uses_llm=True,
)
async def profile_exam_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Write the style profile of a past-exam file (one model call). A file that is no longer an
    exam gets its profile cleared instead."""
    input_data = parse_input(MaterialValidationInput, payload.data)
    result = await profile_exam_material(input_data.materialId)
    return JobOutcome(result=result)


@router.post("/jobs/exam-relevance")
@job_handler(
    job_type="exam_relevance",
    label="Exam relevance",
    default_error_code="EXAM_RELEVANCE_FAILED",
    stage="extracting",
)
async def exam_relevance_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Mark the topics of a project that its past exams test (one model call, only when there are
    past exams and something changed). The daily budget is checked just before that call, so
    clearing the flags after the last past exam is removed works even over budget."""
    project_id = payload.data.get("projectId")
    if not project_id:
        raise PermanentJobError("projectId required", "INVALID_INPUT")

    async def within_budget() -> None:
        if not settings.llm_configured:
            raise PermanentJobError("No model is configured", "LLM_NOT_CONFIGURED")
        unavailable = (await ai_status.get_status()).as_error()
        if unavailable is not None:
            raise unavailable
        message = await over_budget_message(job.user_id)
        if message:
            raise DailyBudgetExceeded(message)

    return JobOutcome(result=await mark_exam_relevant_topics(project_id, before_model=within_budget))


@router.post("/jobs/extract-topics")
@job_handler(
    job_type="extract_topics",
    label="Topic extraction",
    default_error_code="TOPIC_EXTRACTION_FAILED",
    stage="extracting",
    uses_llm=True,
)
async def extract_topics_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Plan the course: units, topics and the sections each topic is taught from.

    The model call(s) run first and write nothing; the plan is then stored in one transaction
    (see app/services/course_planner.py). Before the topics are confirmed this plans the whole
    course; afterwards it places only the sections of files that are new, and confirmed topics
    are never renamed or deleted.
    """
    project_id = payload.data.get("projectId")
    if not project_id:
        raise PermanentJobError("projectId required", "INVALID_INPUT")

    try:
        plan_job = await plan_course(project_id)
    except NoPlannableMaterialError as exc:
        raise PermanentJobError(str(exc), exc.code) from exc

    if plan_job.mode == "full" and not plan_job.plan.topics():
        raise HTTPException(status_code=404, detail="No topics extracted")

    written = await write_plan(plan_job)
    # Topics whose concepts appear in the past exams are marked; this never fails planning.
    await mark_exam_relevant_topics_quietly(project_id)
    total = await execute_one("SELECT count(*)::int AS n FROM topics WHERE project_id = $1", project_id)
    topics_total = total["n"] if total else written["topics"]

    logger.info(
        "Completed course planning (%s): %s new topics in %s units, %s sources, %s confirmed topics kept",
        plan_job.mode, written["topics"], written["units"], written["sources"], written["kept_confirmed"],
    )
    return JobOutcome(
        result={"topics_extracted": topics_total, "new_topics": written["topics"], "mode": plan_job.mode},
        response={"topicsCount": topics_total},
    )


_APPENDABLE_CONTENT = {"solved_examples", "interactive_examples"}

# One statement, so concurrent appends cannot overwrite each other: the upsert locks the
# existing row, and Postgres re-reads it before concatenating. With $5 false (regeneration)
# the new content replaces the old.
_SAVE_CONTENT_SQL = f"""
INSERT INTO topic_content
(id, topic_id, content_type, content_data, metadata, created_at, updated_at)
VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, $4::jsonb, {UTC_NOW}, {UTC_NOW})
ON CONFLICT (topic_id, content_type)
DO UPDATE SET
    content_data = CASE
        WHEN $5::boolean
             AND jsonb_typeof(topic_content.content_data) = 'array'
             AND jsonb_typeof(EXCLUDED.content_data) = 'array'
        THEN topic_content.content_data || EXCLUDED.content_data
        ELSE EXCLUDED.content_data
    END,
    metadata = CASE
        WHEN $5::boolean
             AND jsonb_typeof(topic_content.content_data) = 'array'
             AND jsonb_typeof(EXCLUDED.content_data) = 'array'
             AND EXCLUDED.metadata IS NOT NULL
        THEN jsonb_set(
            EXCLUDED.metadata,
            '{{count}}',
            to_jsonb(jsonb_array_length(topic_content.content_data)
                     + jsonb_array_length(EXCLUDED.content_data))
        )
        ELSE EXCLUDED.metadata
    END,
    updated_at = {UTC_NOW}
RETURNING id,
    CASE WHEN jsonb_typeof(content_data) = 'array'
         THEN jsonb_array_length(content_data) END AS item_count
"""


@router.post("/jobs/generate-content")
@job_handler(
    job_type="generate_content",
    label="Content generation",
    default_error_code="CONTENT_GENERATION_FAILED",
    stage="generating",
    uses_llm=True,
)
async def generate_content_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Generate content for a topic (notes, examples, or quiz).

    Jobs for the same topic run one at a time: a job waits here, holding its claim and lease,
    until the topic's earlier jobs have finished and stored their content.
    """
    input_data = parse_input(ContentGenerationInput, payload.data)

    topic = await execute_one(
        """
        SELECT id, name, description, project_id
        FROM topics
        WHERE id = $1
        """,
        input_data.topicId,
    )

    if not topic:
        raise HTTPException(status_code=404, detail="Topic not found")

    async with topic_lock(topic["id"]):
        try:
            return await _generate_and_store_content(job, input_data, topic)
        except Exception as exc:
            await _skip_failed_topic(job, input_data, topic, exc)
            raise


async def _skip_failed_topic(job: JobContext, input_data: ContentGenerationInput, topic, exc: Exception) -> None:
    """A "Prepare all topics now" run goes on to the next topic when this one cannot be generated
    at all (no source material, or the model refuses it). Any other failure stops the run."""
    if not isinstance(exc, (NoSourceMaterialError, LLMRefusalError)):
        return
    try:
        await continue_chain(
            user_id=job.user_id,
            project_id=job.project_id,
            topic_id=topic["id"],
            preferences={**input_data.preferences, "prepare_rest": False},
            skip_topic=True,
        )
    except Exception:
        logger.exception("Could not continue the generation run after topic %s failed", topic["id"])


def _prerequisite_question_count(preferences: dict) -> int:
    try:
        return min(max(int(preferences.get("prerequisite_questions", 2)), 1), 2)
    except (TypeError, ValueError):
        return 2


async def _usable_prerequisite_id(topic, preferences: dict) -> str | None:
    """The `prerequisite_topic_id` preference when it names another topic of the same project."""
    prerequisite_id = preferences.get("prerequisite_topic_id")
    if not isinstance(prerequisite_id, str) or not prerequisite_id:
        return None
    if prerequisite_id == topic["id"]:
        logger.info("Ignoring prerequisite %s for topic %s: it is the topic itself", prerequisite_id, topic["id"])
        return None
    row = await execute_one("SELECT project_id FROM topics WHERE id = $1", prerequisite_id)
    if not row or row["project_id"] != topic["project_id"]:
        logger.info("Ignoring prerequisite %s for topic %s: not in the same project", prerequisite_id, topic["id"])
        return None
    return prerequisite_id


async def _generate_and_store_content(job: JobContext, input_data: ContentGenerationInput, topic) -> JobOutcome:
    # Nothing is cached the first time a type is generated; regenerating one (more examples,
    # a new quiz set, a regenerated note) caches the excerpt block (see content_generator/context.py).
    cache_excerpts = await content_exists(topic['id'], input_data.contentType)
    generated_content = None
    content_type = input_data.contentType
    focus = input_data.preferences.get("focus")
    append = bool(input_data.preferences.get("append")) and content_type in _APPENDABLE_CONTENT

    # Generate content based on type
    if content_type == "section_notes":
        generator = NotesGenerator()
        result = await generator.generate_notes(
            topic_id=topic['id'],
            topic_name=topic['name'],
            topic_description=topic['description'],
            user_preferences=input_data.preferences,
            cache_excerpts=cache_excerpts,
        )
        generated_content = result['content']
        metadata = {
            'citations': result['citations'],
            'chunk_count': result['chunk_count']
        }

    elif content_type == "solved_examples":
        generator = ExamplesGenerator()
        count = input_data.preferences.get('count', 3)
        difficulty = input_data.preferences.get('difficulty_level', 'medium')

        result = await generator.generate_examples(
            topic_id=topic['id'],
            topic_name=topic['name'],
            topic_description=topic['description'],
            example_type=ExampleType.SOLVED,
            count=count,
            difficulty_level=difficulty,
            focus=focus,
            cache_excerpts=cache_excerpts,
        )
        generated_content = result['examples']
        metadata = {
            'example_type': result['example_type'],
            'difficulty_level': result['difficulty_level'],
            'count': len(result['examples'])
        }

    elif content_type == "interactive_examples":
        generator = ExamplesGenerator()
        count = input_data.preferences.get('count', 3)
        difficulty = input_data.preferences.get('difficulty_level', 'medium')

        result = await generator.generate_examples(
            topic_id=topic['id'],
            topic_name=topic['name'],
            topic_description=topic['description'],
            example_type=ExampleType.INTERACTIVE,
            count=count,
            difficulty_level=difficulty,
            focus=focus,
            cache_excerpts=cache_excerpts,
        )
        generated_content = result['examples']
        metadata = {
            'example_type': result['example_type'],
            'difficulty_level': result['difficulty_level'],
            'count': len(result['examples'])
        }

    elif content_type == "topic_quiz":
        generator = QuizGenerator()
        question_count = input_data.preferences.get('question_count', 10)
        difficulty = input_data.preferences.get('difficulty_level', 'medium')
        question_types_raw = input_data.preferences.get('question_types')
        question_types = None
        if isinstance(question_types_raw, list) and question_types_raw:
            parsed = []
            for entry in question_types_raw:
                try:
                    parsed.append(QuestionType(str(entry)))
                except Exception:
                    continue
            if parsed:
                question_types = parsed

        prerequisite_id = await _usable_prerequisite_id(topic, input_data.preferences)

        result = await generator.generate_quiz(
            topic_id=topic['id'],
            topic_name=topic['name'],
            topic_description=topic['description'],
            question_count=question_count,
            question_types=question_types,
            difficulty_level=difficulty,
            focus=focus,
            cache_excerpts=cache_excerpts,
            prerequisite_topic_id=prerequisite_id,
            prerequisite_questions=_prerequisite_question_count(input_data.preferences),
        )
        generated_content = result['questions']
        metadata = {
            'total_questions': result['total_questions'],
            'difficulty_level': result['difficulty_level'],
            'question_types': result['question_types']
        }

    else:
        raise PermanentJobError(f"Unknown content type: {content_type}", "INVALID_INPUT")

    await job.set_stage("saving", 80)

    quiz_set_id = None
    if content_type == "topic_quiz":
        # Preserve any pre-existing single quiz payload before appending the new set.
        # This keeps the original quiz visible as Set 1 instead of appearing replaced.
        existing_quiz_set_count_row = await execute_one(
            """
            SELECT COUNT(*)::int AS count
            FROM topic_quizzes
            WHERE topic_id = $1
            """,
            topic['id'],
        )
        existing_quiz_set_count = int(existing_quiz_set_count_row.get("count", 0)) if existing_quiz_set_count_row else 0

        if existing_quiz_set_count == 0:
            legacy_quiz_row = await execute_one(
                """
                SELECT content_data, created_at, updated_at
                FROM topic_content
                WHERE topic_id = $1 AND content_type = 'topic_quiz'
                """,
                topic['id'],
            )
            if legacy_quiz_row:
                legacy_questions = _json_value(legacy_quiz_row.get("content_data"))
                if isinstance(legacy_questions, list) and legacy_questions:
                    await execute_update(
                        f"""
                        INSERT INTO topic_quizzes
                        (id, topic_id, questions, created_at)
                        VALUES (gen_random_uuid()::text, $1, $2, COALESCE($3, $4, {UTC_NOW}))
                        """,
                        topic['id'],
                        json.dumps(legacy_questions),
                        legacy_quiz_row.get("updated_at"),
                        legacy_quiz_row.get("created_at"),
                    )

        quiz_set_record = await execute_one(
            f"""
            INSERT INTO topic_quizzes
            (id, topic_id, questions, created_at)
            VALUES (gen_random_uuid()::text, $1, $2, {UTC_NOW})
            RETURNING id
            """,
            topic['id'],
            json.dumps(generated_content),
        )
        if quiz_set_record:
            quiz_set_id = quiz_set_record.get("id")
            if isinstance(metadata, dict):
                metadata["quiz_set_id"] = quiz_set_id

    # Regeneration replaces the stored content; appending (examples only) adds to it.
    content_record = await execute_one(
        _SAVE_CONTENT_SQL,
        topic['id'],
        content_type,
        json.dumps(generated_content),
        json.dumps(metadata) if metadata is not None else None,
        append,
    )
    if append and isinstance(metadata, dict) and content_record["item_count"] is not None:
        metadata["count"] = content_record["item_count"]

    logger.info(f"Completed content generation: {content_type} for topic {topic['id']}")

    # See app/services/generation_chain.py: the topic's next missing type (and, for a whole-course
    # run, the next topic) gets its job row now, before this one is marked completed, and is
    # dispatched once it has been.
    next_job = await plan_next_job(
        user_id=job.user_id,
        project_id=job.project_id,
        topic_id=topic['id'],
        preferences=input_data.preferences,
    )

    async def queue_next():
        await dispatch_job(next_job)

    return JobOutcome(
        result={
            "content_id": content_record['id'],
            "content_type": content_type,
            "metadata": metadata,
        },
        response={"contentId": content_record['id'], "contentType": content_type},
        after=queue_next,
    )


@router.post("/jobs/generate-exam")
@job_handler(
    job_type="generate_exam",
    label="Exam generation",
    default_error_code="EXAM_GENERATION_FAILED",
    stage="generating",
    uses_llm=True,
)
async def generate_exam_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Generate a sample exam across multiple topics."""
    input_data = parse_input(ExamGenerationInput, payload.data)

    generator = ExamGenerator()
    result = await generator.generate_exam(
        project_id=input_data.projectId,
        topic_ids=input_data.topicIds,
        config=input_data.config,
    )

    exam_record = await execute_one(
        f"""
        INSERT INTO sample_exams
        (id, project_id, name, questions, duration_minutes, difficulty_level, topics_covered, created_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, {UTC_NOW})
        RETURNING id
        """,
        input_data.projectId,
        f"Sample Exam - {result['generated_at'][:10]}",
        json.dumps(result['questions']),
        result['duration_minutes'],
        result['difficulty_level'],
        result['topics_covered'],
    )

    logger.info(f"Completed exam generation: {result['total_questions']} questions")
    return JobOutcome(
        result={
            "exam_id": exam_record['id'],
            "total_questions": result['total_questions'],
            "topics_covered": result['topics_covered'],
            "matched_past_exams": result['matched_past_exams'],
        },
        response={
            "examId": exam_record['id'],
            "totalQuestions": result['total_questions'],
        },
    )


@router.post("/jobs/grade-exam")
@job_handler(
    job_type="grade_exam",
    label="Exam grading",
    default_error_code="EXAM_GRADING_FAILED",
    stage="grading",
    uses_llm=True,
    # The answers are the student's work: grading waits for the AI instead of failing.
    wait_for_ai=True,
)
async def grade_exam_job(payload: JobPayload, job: JobContext) -> JobOutcome:
    """Grade an exam submission. The task carries only the submission id."""
    submission_id = payload.data.get("submissionId")
    if not isinstance(submission_id, str) or not submission_id:
        raise PermanentJobError("Missing submissionId", "INVALID_INPUT")

    submission = await execute_one(
        """
        SELECT es.user_id, es.answers, se.questions, se.project_id
        FROM exam_submissions es
        JOIN sample_exams se ON se.id = es.sample_exam_id
        WHERE es.id = $1
          AND es.status = 'submitted'
        """,
        submission_id,
    )
    if not submission:
        # Missing, or an attempt still in progress: only submitted attempts are graded.
        raise PermanentJobError("Exam submission not found", "SUBMISSION_NOT_FOUND")

    questions = _json_value(submission["questions"])
    answers = _json_value(submission["answers"])
    if not isinstance(questions, list) or len(questions) == 0:
        raise PermanentJobError("The exam has no questions", "INVALID_INPUT")
    if not isinstance(answers, dict):
        raise PermanentJobError("The submission has no answers", "INVALID_INPUT")

    grading_result = await ExamGrader().grade_submission(
        submission_id=submission_id,
        questions=questions,
        answers=answers,
    )

    signals = []
    for graded_question in grading_result.get("graded_questions", []):
        topic_id = None
        question_index = graded_question.get("question_index")
        if isinstance(question_index, int) and 0 <= question_index < len(questions):
            question_payload = questions[question_index]
            if isinstance(question_payload, dict):
                topic_id = question_payload.get("topic_id")

        points_possible = graded_question.get("points_possible", 0) or 0
        points_earned = graded_question.get("points_earned", 0) or 0
        score = 0.0
        if points_possible and isinstance(points_possible, (int, float)):
            score = float(points_earned) / float(points_possible)

        signals.append((
            submission["user_id"],
            submission["project_id"],
            topic_id,
            score,
            json.dumps({
                "submission_id": submission_id,
                "question_index": question_index,
                "points_possible": points_possible,
                "points_earned": points_earned,
            }),
        ))

    async def store_grading(conn):
        await conn.execute(
            f"""
            UPDATE exam_submissions
            SET ai_grading = $1,
                ai_feedback = $2,
                graded_at = {UTC_NOW},
                review_applied_at = NULL
            WHERE id = $3
            """,
            json.dumps(grading_result),
            json.dumps(
                {
                    "overall_score": grading_result["overall_score"],
                    "earned_points": grading_result["earned_points"],
                    "total_points": grading_result["total_points"],
                }
            ),
            submission_id,
        )
        # A regrade replaces the submission's earlier signals instead of adding to them.
        await conn.execute(
            """
            DELETE FROM learning_signals
            WHERE user_id = $1 AND source = 'exam' AND metadata->>'submission_id' = $2
            """,
            submission["user_id"],
            submission_id,
        )
        await conn.executemany(
            f"""
            INSERT INTO learning_signals
            (id, user_id, project_id, topic_id, source, score, metadata, created_at)
            VALUES (gen_random_uuid()::text, $1, $2, $3, 'exam', $4, $5, {UTC_NOW})
            """,
            signals,
        )

    await execute_in_transaction(store_grading)

    logger.info(f"Completed exam grading: {grading_result['overall_score']}%")
    return JobOutcome(
        result={
            "submission_id": submission_id,
            "overall_score": grading_result["overall_score"],
            "earned_points": grading_result["earned_points"],
            "total_points": grading_result["total_points"],
        },
        response={"overallScore": grading_result["overall_score"]},
    )
