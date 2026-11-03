-- How long a voice turn took (spec 19.10): the server timings and the browser's for the same turn. No text. Additive only.

-- CreateTable
CREATE TABLE "voice_turn_timings" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "style" TEXT NOT NULL,
    "pre_run" TEXT,
    "graded" BOOLEAN NOT NULL,
    "model_calls" INTEGER NOT NULL,
    "ttft_ms" JSONB NOT NULL,
    "step_ms" INTEGER NOT NULL,
    "first_text_ms" INTEGER,
    "total_ms" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "client" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_turn_timings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_turn_timings_created_at_idx" ON "voice_turn_timings"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "voice_turn_timings_session_id_turn_key" ON "voice_turn_timings"("session_id", "turn");

-- AddForeignKey
ALTER TABLE "voice_turn_timings" ADD CONSTRAINT "voice_turn_timings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "voice_drill_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

