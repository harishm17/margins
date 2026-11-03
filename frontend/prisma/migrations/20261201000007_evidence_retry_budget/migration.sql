-- Failed tries and the time of the last one for owed concept evidence, so a write that keeps failing is
-- tried at most once an hour and given up on after a few tries. Additive only.

-- AlterTable
ALTER TABLE "quiz_attempts" ADD COLUMN     "evidence_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "evidence_tried_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "exam_submissions" ADD COLUMN     "evidence_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "evidence_tried_at" TIMESTAMP(3);
