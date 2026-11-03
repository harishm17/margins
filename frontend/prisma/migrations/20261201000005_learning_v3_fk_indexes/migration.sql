-- Single-column indexes for the foreign keys of the learning-v3 tables that no composite index leads
-- with, so cascade and set-null deletes of a concept, topic or project do not scan. Additive only.

-- CreateIndex
CREATE INDEX "evidence_events_concept_id_idx" ON "evidence_events"("concept_id");

-- CreateIndex
CREATE INDEX "evidence_events_project_id_idx" ON "evidence_events"("project_id");

-- CreateIndex
CREATE INDEX "evidence_events_topic_id_idx" ON "evidence_events"("topic_id");

-- CreateIndex
CREATE INDEX "concept_memories_concept_id_idx" ON "concept_memories"("concept_id");

-- CreateIndex
CREATE INDEX "concept_memories_project_id_idx" ON "concept_memories"("project_id");

-- CreateIndex
CREATE INDEX "recall_attempts_topic_id_idx" ON "recall_attempts"("topic_id");

-- CreateIndex
CREATE INDEX "item_sessions_project_id_idx" ON "item_sessions"("project_id");
