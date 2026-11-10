-- What the watchdog reads (OPS-H1, OPS-H2, OPS-M5): ops_state holds facts such as the last good backup, the
-- last watchdog run and the embedding model the stored vectors were made with; ops_events counts failures that
-- were handled where they happened; ops_alerts keeps each alert kind's cooldown so one process sends it. Additive only.

-- CreateTable
CREATE TABLE "ops_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ops_events" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_alerts" (
    "kind" TEXT NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,
    "last_message" TEXT NOT NULL,

    CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("kind")
);

-- CreateIndex
CREATE INDEX "ops_events_kind_created_at_idx" ON "ops_events"("kind", "created_at");

-- CreateIndex
CREATE INDEX "ops_events_created_at_idx" ON "ops_events"("created_at");

