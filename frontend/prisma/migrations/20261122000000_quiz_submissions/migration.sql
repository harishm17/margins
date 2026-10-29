-- Topic quizzes submitted while short answers cannot be graded (AI unavailable): the answers are kept
-- and a grade_quiz job waits for the AI, like exam grading. Additive only: a new table.

-- CreateTable
CREATE TABLE "quiz_submissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "quiz_set_id" TEXT,
    "answers" JSONB NOT NULL,
    "questions" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ai_grading" JSONB,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graded_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "quiz_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_submissions_user_id_topic_id_submitted_at_idx" ON "quiz_submissions"("user_id", "topic_id", "submitted_at");

-- CreateIndex
CREATE INDEX "quiz_submissions_topic_id_idx" ON "quiz_submissions"("topic_id");

-- AddForeignKey
ALTER TABLE "quiz_submissions" ADD CONSTRAINT "quiz_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_submissions" ADD CONSTRAINT "quiz_submissions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
