-- Learning v3, the learner model: concepts with their claims and edges, the append-only evidence log,
-- the per-student concept memory (a cache rebuilt from the evidence), recall attempts, margin notes,
-- tutor state and item sessions (warm-ups, review sessions, drills), plus the topic path stages on
-- topic_progress. Additive only. Every new table cascades on the user and the course.
--
-- The three array columns (concepts.objective_indexes, tutor_states.concept_ids,
-- item_sessions.topic_ids) default to an empty array so rows written by raw SQL read as []; `prisma
-- migrate dev` may propose dropping those defaults: keep them.

-- AlterTable
ALTER TABLE "topic_progress" ADD COLUMN     "explainer_unlock_reason" TEXT,
ADD COLUMN     "explainer_unlocked_at" TIMESTAMP(3),
ADD COLUMN     "read_at" TIMESTAMP(3),
ADD COLUMN     "recall_at" TIMESTAMP(3),
ADD COLUMN     "warmup_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "concepts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "objective_indexes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "difficulty_prior" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "merged_into_id" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'llm',
    "embedding" vector(384),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_claims" (
    "id" TEXT NOT NULL,
    "concept_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "chunk_id" TEXT,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "concept_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_edges" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'llm',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "evidence_quote" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "topic_id" TEXT,
    "concept_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "assistance" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION NOT NULL,
    "role" TEXT NOT NULL,
    "graded_by" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "session_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_memories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "concept_id" TEXT NOT NULL,
    "card" JSONB,
    "due_at" TIMESTAMP(3),
    "stability" DOUBLE PRECISION,
    "last_review_at" TIMESTAMP(3),
    "n_unassisted" INTEGER NOT NULL DEFAULT 0,
    "n_assisted" INTEGER NOT NULL DEFAULT 0,
    "last_evidence_at" TIMESTAMP(3),
    "last_assisted_at" TIMESTAMP(3),
    "inferred_prior" DOUBLE PRECISION,
    "misconception" TEXT,
    "misconception_at" TIMESTAMP(3),
    "consecutive_fails" INTEGER NOT NULL DEFAULT 0,
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL DEFAULT 'not_started',
    "derived" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concept_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_attempts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt_text" TEXT NOT NULL,
    "objective_index" INTEGER,
    "answer_text" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "explainer" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "margin_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "reply" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "margin_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "rung" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "low_effort_turns" INTEGER NOT NULL DEFAULT 0,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "concept_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutor_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "topic_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "items" JSONB NOT NULL,
    "answers" JSONB,
    "results" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "item_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concepts_project_id_topic_id_order_index_idx" ON "concepts"("project_id", "topic_id", "order_index");

-- CreateIndex
CREATE INDEX "concepts_topic_id_idx" ON "concepts"("topic_id");

-- CreateIndex
CREATE INDEX "concept_claims_concept_id_idx" ON "concept_claims"("concept_id");

-- CreateIndex
CREATE INDEX "concept_claims_material_id_idx" ON "concept_claims"("material_id");

-- CreateIndex
CREATE INDEX "concept_edges_project_id_idx" ON "concept_edges"("project_id");

-- CreateIndex
CREATE INDEX "concept_edges_target_id_idx" ON "concept_edges"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_edges_source_id_target_id_type_key" ON "concept_edges"("source_id", "target_id", "type");

-- CreateIndex
CREATE INDEX "evidence_events_user_id_concept_id_created_at_idx" ON "evidence_events"("user_id", "concept_id", "created_at");

-- CreateIndex
CREATE INDEX "evidence_events_user_id_project_id_created_at_idx" ON "evidence_events"("user_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "concept_memories_user_id_project_id_due_at_idx" ON "concept_memories"("user_id", "project_id", "due_at");

-- CreateIndex
CREATE INDEX "concept_memories_topic_id_idx" ON "concept_memories"("topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_memories_user_id_concept_id_key" ON "concept_memories"("user_id", "concept_id");

-- CreateIndex
CREATE INDEX "recall_attempts_user_id_topic_id_created_at_idx" ON "recall_attempts"("user_id", "topic_id", "created_at");

-- CreateIndex
CREATE INDEX "margin_notes_user_id_topic_id_created_at_idx" ON "margin_notes"("user_id", "topic_id", "created_at");

-- CreateIndex
CREATE INDEX "margin_notes_material_id_idx" ON "margin_notes"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_states_user_id_scope_scope_key_key" ON "tutor_states"("user_id", "scope", "scope_key");

-- CreateIndex
CREATE INDEX "item_sessions_user_id_project_id_created_at_idx" ON "item_sessions"("user_id", "project_id", "created_at");

-- AddForeignKey
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_claims" ADD CONSTRAINT "concept_claims_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_claims" ADD CONSTRAINT "concept_claims_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_edges" ADD CONSTRAINT "concept_edges_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_edges" ADD CONSTRAINT "concept_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_edges" ADD CONSTRAINT "concept_edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_states" ADD CONSTRAINT "tutor_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_sessions" ADD CONSTRAINT "item_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_sessions" ADD CONSTRAINT "item_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
