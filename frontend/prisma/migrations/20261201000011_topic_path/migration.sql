-- The student has seen the one-time card that explains trying before help (spec 5). Additive only.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "seen_effort_intro_at" TIMESTAMP(3);
