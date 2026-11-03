-- Practice rungs: which steps were checked, which were right on the first check, the highest help
-- rung per step, and the "What tripped you up?" answer. Additive only; rows from before stay valid
-- (empty arrays, null rungs).
--
-- The two array columns default to an empty array so rows written by raw SQL read as []; `prisma
-- migrate dev` may propose dropping those defaults: keep them.

-- AlterTable
ALTER TABLE "practice_progress" ADD COLUMN     "attempted_steps" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "first_try_steps" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "max_rungs" JSONB,
ADD COLUMN     "tripped_up" TEXT;
