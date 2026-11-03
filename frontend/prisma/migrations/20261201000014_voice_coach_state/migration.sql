-- Where a teach-back or guided-reading voice session is: probes per gap, the claim being read. Additive only.

-- AlterTable
ALTER TABLE "voice_drill_sessions" ADD COLUMN     "coach_state" JSONB;
