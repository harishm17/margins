-- One waiting submission per user, topic, quiz set and answers: two submits at once (a double click,
-- two tabs) cannot store the same quiz twice. Additive and safe to run on a live database: a nullable
-- column (no rewrite) and an index on a table that only holds quizzes waiting for the AI (small, and
-- empty before this feature). Rows without a hash never conflict.

-- AlterTable
ALTER TABLE "quiz_submissions" ADD COLUMN "answers_hash" TEXT;

-- CreateIndex (partial, with the null quiz set read as '': Prisma cannot express it)
CREATE UNIQUE INDEX "quiz_submissions_pending_dedupe_idx"
ON "quiz_submissions"("user_id", "topic_id", COALESCE("quiz_set_id", ''), "answers_hash")
WHERE "status" = 'pending';
