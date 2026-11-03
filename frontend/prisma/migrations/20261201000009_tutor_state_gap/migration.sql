-- The gap (step or claim) the tutor last addressed, so a reply on a new gap resets the stalled-reply count.
-- Additive only.

-- AlterTable
ALTER TABLE "tutor_states" ADD COLUMN     "gap_id" TEXT;
