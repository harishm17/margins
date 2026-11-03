-- Final review fixes. Additive only.
--
-- evidence_events: the two lookups the evidence writer repeats under its locks (replace by session key,
-- skip an item already present).
-- tutor_states: the help actually given on a practice step and the help level at its first wrong check, so
--   practice evidence is read from the server's own record.
-- practice_progress: the steps whose evidence is written for the current run. Rows from before count every
--   finished step as written (they were written when they finished), so nothing is written twice.
--
-- evidence_steps defaults to an empty array; `prisma migrate dev` may propose dropping that default: keep it.

-- CreateIndex
CREATE INDEX "evidence_events_user_id_session_key_idx" ON "evidence_events"("user_id", "session_key");

-- CreateIndex
CREATE INDEX "evidence_events_user_id_item_key_idx" ON "evidence_events"("user_id", "item_key");

-- AlterTable
ALTER TABLE "tutor_states" ADD COLUMN     "help_rung" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "first_miss_rung" INTEGER;

-- AlterTable
ALTER TABLE "practice_progress" ADD COLUMN     "evidence_steps" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

UPDATE "practice_progress"
SET "evidence_steps" = ARRAY(SELECT DISTINCT s FROM unnest("solved_steps" || "revealed_steps") AS s ORDER BY s);
