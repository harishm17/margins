-- Help and adaptation (spec 18.11): one additive migration. The String[] column keeps a database
-- default (an empty array), which `prisma migrate dev` would otherwise propose to drop.

-- AlterTable
ALTER TABLE "quiz_submissions" ADD COLUMN     "rule_graded_at" TIMESTAMP(3),
ADD COLUMN     "rule_results" JSONB;

-- AlterTable
ALTER TABLE "topic_progress" ADD COLUMN     "tested_out_at" TIMESTAMP(3),
ADD COLUMN     "triage" TEXT,
ADD COLUMN     "triage_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tutor_states" ADD COLUMN     "cant_parse_turns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dont_know_at" TIMESTAMP(3),
ADD COLUMN     "understand_concepts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "understand_no_attempt" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "study_drafts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "topic_id" TEXT,
    "surface" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "study_drafts_user_id_expires_at_idx" ON "study_drafts"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "study_drafts_project_id_idx" ON "study_drafts"("project_id");

-- CreateIndex
CREATE INDEX "study_drafts_topic_id_idx" ON "study_drafts"("topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_drafts_user_id_surface_scope_key_key" ON "study_drafts"("user_id", "surface", "scope_key");

-- AddForeignKey
ALTER TABLE "study_drafts" ADD CONSTRAINT "study_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_drafts" ADD CONSTRAINT "study_drafts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_drafts" ADD CONSTRAINT "study_drafts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
