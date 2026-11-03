-- Evidence backfill per topic, and a lease instead of a claim-first marker. Additive only.
--
-- topics.evidence_backfilled_at: this topic's history has been converted to evidence (until then it keeps
-- the legacy mastery blend). projects.evidence_backfill_claimed_at: when a backfill run started; honoured
-- for a short lease so runs do not overlap, and never a "done" signal.

-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "evidence_backfilled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "evidence_backfill_claimed_at" TIMESTAMP(3);
