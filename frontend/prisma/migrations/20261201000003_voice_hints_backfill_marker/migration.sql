-- Voice hints and the evidence backfill marker. Additive only.
--
-- voice_drill_sessions.hinted_questions records which questions had a hint asked for, so an answer
-- after a hint is stored as assisted evidence. It defaults to an empty array so rows written by raw
-- SQL read as []; `prisma migrate dev` may propose dropping that default: keep it.
-- projects.evidence_backfilled_at is set once the project's history has been turned into evidence.

-- AlterTable
ALTER TABLE "voice_drill_sessions" ADD COLUMN     "hinted_questions" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "evidence_backfilled_at" TIMESTAMP(3);
