-- Whether the concept evidence of a graded quiz attempt or exam submission has been written, so a write
-- that failed after the result committed is tried again. Additive only; rows that exist are marked done
-- (their evidence, if any, came from the backfill).

-- AlterTable
ALTER TABLE "quiz_attempts" ADD COLUMN     "evidence_recorded_at" TIMESTAMP(3),
ADD COLUMN     "evidence_pending" JSONB;

-- AlterTable
ALTER TABLE "exam_submissions" ADD COLUMN     "evidence_recorded_at" TIMESTAMP(3);

UPDATE "quiz_attempts" SET "evidence_recorded_at" = CURRENT_TIMESTAMP;
UPDATE "exam_submissions" SET "evidence_recorded_at" = CURRENT_TIMESTAMP WHERE "graded_at" IS NOT NULL;
