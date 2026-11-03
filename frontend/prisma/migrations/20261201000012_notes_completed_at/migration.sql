-- When the notes were marked complete: the date a topic read before the learning path counts as learned. Additive only.

-- AlterTable
ALTER TABLE "topic_progress" ADD COLUMN     "notes_completed_at" TIMESTAMP(3);

-- Rows completed before this column existed: the last visit is the best date there is, taken once.
UPDATE "topic_progress" SET "notes_completed_at" = COALESCE("last_accessed_at", "read_at", TIMESTAMP '1970-01-01') WHERE "notes_completed" = true AND "notes_completed_at" IS NULL;
