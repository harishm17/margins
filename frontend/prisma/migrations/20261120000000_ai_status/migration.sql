-- Whether the AI provider can be used right now (one row, id 'global'), written by the AI service:
-- see app/services/ai_status.py there. Additive only: a new table.

-- CreateTable
CREATE TABLE "ai_status" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "state" TEXT NOT NULL DEFAULT 'available',
    "reason" TEXT,
    "since" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" TEXT,

    CONSTRAINT "ai_status_pkey" PRIMARY KEY ("id")
);
