-- PR 1.9b (SEC-L3, OPS-M6, SEC-L1 voice). Data rewrite; no schema change.
--
-- expand-contract: this only rewrites values in existing columns (no column or constraint is added or removed), the
-- new code writes and reads the same shapes, and the rewrite is idempotent, so the old and new versions can run on it.

-- 1. Stored job errors become the public message for their code. Raw exception text could hold a student's words, a
--    model's reply or a path; from now on a job row carries the code and the fixed text for it, and nothing else.
--    A row with no code, or one this table does not know, gets the generic text.
UPDATE "processing_jobs"
SET "error_message" = CASE "error_code"
        WHEN 'AI_UNREACHABLE' THEN 'AI features are paused right now.'
        WHEN 'ATTEMPT_NOT_FOUND' THEN 'We could not find that attempt.'
        WHEN 'CHAT_FAILED' THEN 'The answer could not be written.'
        WHEN 'CHUNKING_FAILED' THEN 'We could not read the pages of this file.'
        WHEN 'CONCEPT_EXTRACTION_FAILED' THEN 'We could not find the concepts in this topic.'
        WHEN 'CONCEPT_LINKING_FAILED' THEN 'We could not link the concepts in this topic.'
        WHEN 'CONTENT_GENERATION_FAILED' THEN 'The study content could not be written.'
        WHEN 'ENQUEUE_FAILED' THEN 'The job could not be started.'
        WHEN 'ENQUEUE_PERMANENT' THEN 'The job could not be started.'
        WHEN 'EXAM_GENERATION_FAILED' THEN 'The mock exam could not be written.'
        WHEN 'EXAM_GRADING_FAILED' THEN 'We could not finish grading this exam.'
        WHEN 'EXAM_PROFILE_FAILED' THEN 'We could not read the style of your past exams.'
        WHEN 'EXAM_RELEVANCE_FAILED' THEN 'We could not match your past exams to your topics.'
        WHEN 'GAP_EXPLAINER_FAILED' THEN 'The explanation could not be written.'
        WHEN 'INVALID_INPUT' THEN 'The request was not complete.'
        WHEN 'JOB_DISPATCH_FAILED' THEN 'The job could not be started.'
        WHEN 'JOB_FAILED' THEN 'Something went wrong. Try again in a moment.'
        WHEN 'JOB_LEASE_EXPIRED' THEN 'The work stopped before it finished.'
        WHEN 'LLM_AUTH_FAILED' THEN 'AI features are paused right now.'
        WHEN 'LLM_BAD_OUTPUT' THEN 'The AI returned an answer the app could not use.'
        WHEN 'LLM_BUSY' THEN 'Margins is busy right now. Try again in a moment.'
        WHEN 'LLM_CREDIT_EXHAUSTED' THEN 'AI features are paused right now.'
        WHEN 'LLM_DAILY_BUDGET' THEN 'You''ve used today''s AI allowance.'
        WHEN 'LLM_ERROR' THEN 'Something went wrong. Try again in a moment.'
        WHEN 'LLM_NOT_CONFIGURED' THEN 'AI features are paused right now.'
        WHEN 'LLM_RATE_LIMITED' THEN 'The AI is busy right now. Try again in a few minutes.'
        WHEN 'LLM_REFUSED' THEN 'The AI declined to write this from your material.'
        WHEN 'LLM_REPLAY_MISS' THEN 'No recorded answer exists for this request.'
        WHEN 'LLM_REQUEST_REJECTED' THEN 'The AI could not take this request.'
        WHEN 'LLM_UNAVAILABLE' THEN 'The AI is busy right now. Try again in a few minutes.'
        WHEN 'MATERIAL_NOT_FOUND' THEN 'That file was removed before it could be read.'
        WHEN 'MATERIAL_UNREADABLE' THEN 'This file could not be read.'
        WHEN 'NOT_FOUND' THEN 'We could not find that.'
        WHEN 'NO_CONTENT' THEN 'No readable text was found in this file.'
        WHEN 'NO_CONTENT_MATERIALS' THEN 'Every material in this course is marked as a syllabus or a past exam.'
        WHEN 'NO_SOURCE_MATERIAL' THEN 'None of your uploaded material matched this topic.'
        WHEN 'PROJECT_NOT_FOUND' THEN 'We could not find that course.'
        WHEN 'QUIZ_GRADING_FAILED' THEN 'We could not finish grading this quiz.'
        WHEN 'QUIZ_SUBMISSION_NOT_FOUND' THEN 'That quiz attempt could not be found.'
        WHEN 'RETRIEVAL_FAILED' THEN 'The materials could not be searched just now.'
        WHEN 'REVIEW_ITEMS_FAILED' THEN 'The review items could not be written.'
        WHEN 'STORAGE_UNAVAILABLE' THEN 'Your files could not be read just now.'
        WHEN 'SUBMISSION_NOT_FOUND' THEN 'That exam attempt could not be found.'
        WHEN 'TOPIC_EXTRACTION_FAILED' THEN 'We could not find the topics in your files.'
        WHEN 'VALIDATION_ERROR' THEN 'The request was not valid.'
        WHEN 'VALIDATION_FAILED' THEN 'We could not check this file.'
        WHEN 'VOICE_TURN_FAILED' THEN 'The coach could not reply.'
        ELSE 'Something went wrong. Try again in a moment.'
    END
WHERE "error_message" IS NOT NULL
  AND "error_message" IS DISTINCT FROM CASE "error_code"
        WHEN 'AI_UNREACHABLE' THEN 'AI features are paused right now.'
        WHEN 'ATTEMPT_NOT_FOUND' THEN 'We could not find that attempt.'
        WHEN 'CHAT_FAILED' THEN 'The answer could not be written.'
        WHEN 'CHUNKING_FAILED' THEN 'We could not read the pages of this file.'
        WHEN 'CONCEPT_EXTRACTION_FAILED' THEN 'We could not find the concepts in this topic.'
        WHEN 'CONCEPT_LINKING_FAILED' THEN 'We could not link the concepts in this topic.'
        WHEN 'CONTENT_GENERATION_FAILED' THEN 'The study content could not be written.'
        WHEN 'ENQUEUE_FAILED' THEN 'The job could not be started.'
        WHEN 'ENQUEUE_PERMANENT' THEN 'The job could not be started.'
        WHEN 'EXAM_GENERATION_FAILED' THEN 'The mock exam could not be written.'
        WHEN 'EXAM_GRADING_FAILED' THEN 'We could not finish grading this exam.'
        WHEN 'EXAM_PROFILE_FAILED' THEN 'We could not read the style of your past exams.'
        WHEN 'EXAM_RELEVANCE_FAILED' THEN 'We could not match your past exams to your topics.'
        WHEN 'GAP_EXPLAINER_FAILED' THEN 'The explanation could not be written.'
        WHEN 'INVALID_INPUT' THEN 'The request was not complete.'
        WHEN 'JOB_DISPATCH_FAILED' THEN 'The job could not be started.'
        WHEN 'JOB_FAILED' THEN 'Something went wrong. Try again in a moment.'
        WHEN 'JOB_LEASE_EXPIRED' THEN 'The work stopped before it finished.'
        WHEN 'LLM_AUTH_FAILED' THEN 'AI features are paused right now.'
        WHEN 'LLM_BAD_OUTPUT' THEN 'The AI returned an answer the app could not use.'
        WHEN 'LLM_BUSY' THEN 'Margins is busy right now. Try again in a moment.'
        WHEN 'LLM_CREDIT_EXHAUSTED' THEN 'AI features are paused right now.'
        WHEN 'LLM_DAILY_BUDGET' THEN 'You''ve used today''s AI allowance.'
        WHEN 'LLM_ERROR' THEN 'Something went wrong. Try again in a moment.'
        WHEN 'LLM_NOT_CONFIGURED' THEN 'AI features are paused right now.'
        WHEN 'LLM_RATE_LIMITED' THEN 'The AI is busy right now. Try again in a few minutes.'
        WHEN 'LLM_REFUSED' THEN 'The AI declined to write this from your material.'
        WHEN 'LLM_REPLAY_MISS' THEN 'No recorded answer exists for this request.'
        WHEN 'LLM_REQUEST_REJECTED' THEN 'The AI could not take this request.'
        WHEN 'LLM_UNAVAILABLE' THEN 'The AI is busy right now. Try again in a few minutes.'
        WHEN 'MATERIAL_NOT_FOUND' THEN 'That file was removed before it could be read.'
        WHEN 'MATERIAL_UNREADABLE' THEN 'This file could not be read.'
        WHEN 'NOT_FOUND' THEN 'We could not find that.'
        WHEN 'NO_CONTENT' THEN 'No readable text was found in this file.'
        WHEN 'NO_CONTENT_MATERIALS' THEN 'Every material in this course is marked as a syllabus or a past exam.'
        WHEN 'NO_SOURCE_MATERIAL' THEN 'None of your uploaded material matched this topic.'
        WHEN 'PROJECT_NOT_FOUND' THEN 'We could not find that course.'
        WHEN 'QUIZ_GRADING_FAILED' THEN 'We could not finish grading this quiz.'
        WHEN 'QUIZ_SUBMISSION_NOT_FOUND' THEN 'That quiz attempt could not be found.'
        WHEN 'RETRIEVAL_FAILED' THEN 'The materials could not be searched just now.'
        WHEN 'REVIEW_ITEMS_FAILED' THEN 'The review items could not be written.'
        WHEN 'STORAGE_UNAVAILABLE' THEN 'Your files could not be read just now.'
        WHEN 'SUBMISSION_NOT_FOUND' THEN 'That exam attempt could not be found.'
        WHEN 'TOPIC_EXTRACTION_FAILED' THEN 'We could not find the topics in your files.'
        WHEN 'VALIDATION_ERROR' THEN 'The request was not valid.'
        WHEN 'VALIDATION_FAILED' THEN 'We could not check this file.'
        WHEN 'VOICE_TURN_FAILED' THEN 'The coach could not reply.'
        ELSE 'Something went wrong. Try again in a moment.'
    END;

-- 2. Material notes that carried an exception (the AI check's error text) or a file name's extension become the fixed notes.
UPDATE "materials"
SET "validation_notes" = 'Validation completed using structural checks only (the AI check was unavailable).'
WHERE "validation_notes" LIKE '%LLM unavailable:%';

UPDATE "materials"
SET "validation_notes" = 'This file type is not supported. Supported formats: .pdf, .docx, .pptx, .doc'
WHERE "validation_notes" LIKE 'Unsupported file type ''%';

-- 3. Voice: a sprint session belongs to no topic, and a session never points at a topic of another user's course.
UPDATE "voice_drill_sessions"
SET "topic_id" = NULL
WHERE "topic_id" IS NOT NULL
  AND ("mode" = 'sprint'
       OR NOT EXISTS (
            SELECT 1 FROM "topics" t JOIN "projects" p ON p."id" = t."project_id"
            WHERE t."id" = "voice_drill_sessions"."topic_id" AND p."user_id" = "voice_drill_sessions"."user_id"));
