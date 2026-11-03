-- What the server saw of the student's checked answers on the step (the browser's own count is lost on a
-- reload and is not trusted): how many checks, how many were wrong, whether the last one was wrong and
-- whether the correct answer was ever given. Additive only.

-- AlterTable
ALTER TABLE "tutor_states" ADD COLUMN     "checks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wrong_checks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_check_wrong" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checked_correct" BOOLEAN NOT NULL DEFAULT false;
