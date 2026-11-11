-- Voice minutes count the time a session is in use, not the time its tab is open (finding 71, plan V4).
--
-- Before: a session used the wall time from its first turn to its end, or to its last heartbeat. A tab left open sends
-- a heartbeat every 30 seconds, so a student who walked away kept using minutes.
-- Now: voice_drill_sessions.active_ms holds the time counted so far and active_at the moment it was counted up to. The
-- web app adds to it at the start and the end of every turn (src/lib/voice/usage.ts, creditActivity): a turn counts in
-- full, a pause of up to two minutes before the next turn counts in full, and a longer pause, or the time after the
-- last turn, counts 20 seconds.
--
-- Expand only. An old web app instance still running during the deploy does not write the new columns; the sessions it
-- runs in those minutes count less than they used.

ALTER TABLE "voice_drill_sessions" ADD COLUMN "active_ms" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "voice_drill_sessions" ADD COLUMN "active_at" TIMESTAMP(3);

-- Sessions from before this migration keep what they used: the wall time, as it was counted then.
UPDATE "voice_drill_sessions"
SET "active_at" = GREATEST(COALESCE("ended_at", "connected_at"), COALESCE("last_seen_at", "connected_at")),
    "active_ms" = LEAST(
        7200000,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
            GREATEST(COALESCE("ended_at", "connected_at"), COALESCE("last_seen_at", "connected_at")) - "connected_at"
        )) * 1000)::INTEGER)
    )
WHERE "connected_at" IS NOT NULL;

-- The kept usage (voice_usage) follows: the counted time, plus what sessionSeconds() adds for the time since it was
-- last counted (at most 20 seconds, up to the end or the last sign of life). At most two hours, as before.
CREATE OR REPLACE FUNCTION "voice_usage_track"() RETURNS TRIGGER AS $$
DECLARE
    v_spend_key TEXT;
    v_until TIMESTAMP(3);
    v_tail_ms INTEGER;
BEGIN
    IF NEW."connected_at" IS NULL THEN
        DELETE FROM "voice_usage" WHERE "session_id" = NEW."id";
        RETURN NEW;
    END IF;
    SELECT "spend_key" INTO v_spend_key FROM "users" WHERE "id" = NEW."user_id";
    v_until := COALESCE(NEW."ended_at", NEW."last_seen_at", NEW."active_at");
    v_tail_ms := CASE
        WHEN NEW."active_at" IS NULL OR v_until IS NULL THEN 0
        ELSE LEAST(20000, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_until - NEW."active_at")) * 1000)::INTEGER))
    END;
    INSERT INTO "voice_usage" ("session_id", "spend_key", "connected_at", "seconds", "updated_at")
    VALUES (
        NEW."id", v_spend_key, NEW."connected_at",
        LEAST(7200, (NEW."active_ms" + v_tail_ms) / 1000),
        CURRENT_TIMESTAMP
    )
    ON CONFLICT ("session_id") DO UPDATE SET
        "spend_key" = COALESCE(EXCLUDED."spend_key", "voice_usage"."spend_key"),
        "connected_at" = EXCLUDED."connected_at",
        "seconds" = EXCLUDED."seconds",
        "updated_at" = EXCLUDED."updated_at";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The same trigger, now also run when the counted time changes.
DROP TRIGGER "voice_usage_track" ON "voice_drill_sessions";
CREATE TRIGGER "voice_usage_track"
    AFTER UPDATE OF "connected_at", "last_seen_at", "ended_at", "active_ms", "active_at" ON "voice_drill_sessions"
    FOR EACH ROW EXECUTE FUNCTION "voice_usage_track"();
