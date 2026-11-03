-- The tutor's ladder bookkeeping beyond the current rung: the highest rung reached, the authored
-- hints opened, guesses with no reasoning in a row, and replies at one rung without progress.
-- Additive only.

-- AlterTable
ALTER TABLE "tutor_states" ADD COLUMN     "bare_guesses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hints_opened" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_rung" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "same_rung_no_progress" INTEGER NOT NULL DEFAULT 0;
