-- PR 1.9b (OPS-L4, OPS-N9, voice double-turn guard). Additive only.

-- Files that a deleted row used to point to, queued in the same transaction as the delete. The AI service's reaper
-- loop removes them from storage (and retries with backoff); the watchdog alerts on rows stuck past a number of attempts.
CREATE TABLE "pending_file_deletions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "path" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),

    CONSTRAINT "pending_file_deletions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_file_deletions_done_at_last_attempt_at_idx" ON "pending_file_deletions"("done_at", "last_attempt_at");

-- The job attempt that wrote a quiz set, so a retry after a crash does not add a second set (a partial unique
-- index; Prisma cannot express it, like processing_jobs_active_target_key).
ALTER TABLE "topic_quizzes" ADD COLUMN "source_job_id" TEXT;

CREATE UNIQUE INDEX "topic_quizzes_source_job_id_key" ON "topic_quizzes"("source_job_id")
    WHERE "source_job_id" IS NOT NULL;

-- Set while a voice turn is running; claimed by a conditional update, so two server processes cannot run two turns
-- of one session at once.
ALTER TABLE "voice_drill_sessions" ADD COLUMN "turn_started_at" TIMESTAMP(3);
