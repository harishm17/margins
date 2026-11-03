-- The rung a practice step had reached at its first wrong check, per step: tells a hint taken before the
-- miss from one taken after it (spec 3.3). Additive only; null on rows from before.

-- AlterTable
ALTER TABLE "practice_progress" ADD COLUMN     "miss_rungs" JSONB;
