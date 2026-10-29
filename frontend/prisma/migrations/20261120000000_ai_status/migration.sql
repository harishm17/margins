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

-- The one row, so the AI service always has a row to lock when the status changes (two first
-- failures at once must not both see a change and both alert the owner).
INSERT INTO "ai_status" ("id", "state", "since", "checked_at")
VALUES ('global', 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
