-- expand-contract: this migration replaces two functions from 20261121000000_account_deletion
-- (llm_usage_events_unlink_deleted_user and delete_user_account) with versions that do everything the old ones did and
-- also keep the account's spend_key. Everything else only adds tables, columns and indexes. Both services keep working
-- against it while the other is still on old code: the old AI service ignores the new columns (its inserts get their
-- spend_key from the trigger), and the old web app's delete_user_account call is the same call.
--
-- A spend_key is a one-way key (an HMAC, computed by the web app, see src/lib/account/spend-key.ts) derived from the
-- Google account. It lets the daily allowance and the voice minutes survive account deletion without keeping anything
-- that identifies the person: deleting an account and signing in again with the same Google account used to start
-- from a fresh $8 and 30 minutes.
--
-- 1. users.spend_key: set when the account is created (and once, at web start-up, for older accounts).
-- 2. spend_accounts: when each key was first seen. Survives deletion; account age is read from it.
-- 3. deleted_accounts: the tombstone delete_user_account() writes, so a ledger row inserted after deletion (a job that
--    was still running) is still stamped with its account's key.
-- 4. llm_usage_events.spend_key, stamped by the insert trigger (from users, else from the tombstone) so no writer can
--    forget or choose it. The daily allowance sums by it.
-- 5. voice_usage: the seconds each voice session used, kept by a trigger on voice_drill_sessions and keyed by
--    spend_key, with no foreign key to the session: deleting a course (which deletes its sessions) or the account does
--    not give the minutes back.
-- 6. voice_drill_sets: a generated drill set per topic, so asking again for the same inputs costs nothing.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "spend_key" TEXT;

-- CreateIndex
CREATE INDEX "users_spend_key_idx" ON "users"("spend_key");

-- CreateTable
CREATE TABLE "spend_accounts" (
    "spend_key" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_accounts_pkey" PRIMARY KEY ("spend_key")
);

-- CreateTable
CREATE TABLE "deleted_accounts" (
    "user_id" TEXT NOT NULL,
    "spend_key" TEXT,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_accounts_pkey" PRIMARY KEY ("user_id")
);

-- AlterTable
ALTER TABLE "llm_usage_events" ADD COLUMN "spend_key" TEXT;

-- CreateIndex
CREATE INDEX "llm_usage_events_spend_key_created_at_idx" ON "llm_usage_events"("spend_key", "created_at");

-- CreateTable
CREATE TABLE "voice_usage" (
    "session_id" TEXT NOT NULL,
    "spend_key" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_usage_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "voice_usage_spend_key_connected_at_idx" ON "voice_usage"("spend_key", "connected_at");

-- CreateTable
CREATE TABLE "voice_drill_sets" (
    "id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "inputs_hash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "questions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_drill_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_drill_sets_topic_id_inputs_hash_key" ON "voice_drill_sets"("topic_id", "inputs_hash");

-- AddForeignKey
ALTER TABLE "voice_drill_sets" ADD CONSTRAINT "voice_drill_sets_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Spend for a deleted account is kept, unlinked, and stamped with the account's key. The key always comes from the
-- database, never from the writer.
CREATE OR REPLACE FUNCTION "llm_usage_events_unlink_deleted_user"() RETURNS TRIGGER AS $$
DECLARE
    v_spend_key TEXT;
BEGIN
    IF NEW."user_id" IS NOT NULL THEN
        SELECT "spend_key" INTO v_spend_key FROM "users" WHERE "id" = NEW."user_id" FOR KEY SHARE;
        IF FOUND THEN
            NEW."spend_key" := v_spend_key;
        ELSE
            SELECT "spend_key" INTO v_spend_key FROM "deleted_accounts" WHERE "user_id" = NEW."user_id";
            NEW."spend_key" := v_spend_key;
            NEW."user_id" := NULL;
            NEW."project_id" := NULL;
            NEW."source_id" := '';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Delete an account: lock it, write the tombstone, unlink its spend (stamping rows not stamped yet), delete it.
CREATE OR REPLACE FUNCTION "delete_user_account"(p_user_id TEXT) RETURNS BOOLEAN AS $$
DECLARE
    v_spend_key TEXT;
BEGIN
    SELECT "spend_key" INTO v_spend_key FROM "users" WHERE "id" = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    INSERT INTO "deleted_accounts" ("user_id", "spend_key") VALUES (p_user_id, v_spend_key)
        ON CONFLICT ("user_id") DO UPDATE SET "spend_key" = EXCLUDED."spend_key", "deleted_at" = CURRENT_TIMESTAMP;
    UPDATE "llm_usage_events"
    SET "user_id" = NULL, "project_id" = NULL, "source_id" = '', "spend_key" = COALESCE("spend_key", v_spend_key)
    WHERE "user_id" = p_user_id;
    DELETE FROM "users" WHERE "id" = p_user_id;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- The seconds a voice session has used, kept up to date wherever the session's timestamps change (the claim on the
-- first turn, each turn, the heartbeat, the end). Mirrors sessionSeconds() in src/lib/voice/usage.ts as of the write:
-- from connection to the later of the end and the last sign of life, at most two hours. A session that releases its
-- claim (connected_at back to NULL after a failed first turn) uses nothing.
CREATE FUNCTION "voice_usage_track"() RETURNS TRIGGER AS $$
DECLARE
    v_spend_key TEXT;
    v_last TIMESTAMP(3);
BEGIN
    IF NEW."connected_at" IS NULL THEN
        DELETE FROM "voice_usage" WHERE "session_id" = NEW."id";
        RETURN NEW;
    END IF;
    SELECT "spend_key" INTO v_spend_key FROM "users" WHERE "id" = NEW."user_id";
    v_last := COALESCE(NEW."last_seen_at", NEW."connected_at");
    IF NEW."ended_at" IS NOT NULL THEN
        v_last := GREATEST(NEW."ended_at", v_last);
    END IF;
    INSERT INTO "voice_usage" ("session_id", "spend_key", "connected_at", "seconds", "updated_at")
    VALUES (
        NEW."id", v_spend_key, NEW."connected_at",
        LEAST(7200, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_last - NEW."connected_at")))::INTEGER)),
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

CREATE TRIGGER "voice_usage_track"
    AFTER UPDATE OF "connected_at", "last_seen_at", "ended_at" ON "voice_drill_sessions"
    FOR EACH ROW EXECUTE FUNCTION "voice_usage_track"();

-- Sessions of the last 24 hours (the usage window) count from the moment this runs. Their spend_key is filled in by the
-- web app's start-up backfill with the users'.
INSERT INTO "voice_usage" ("session_id", "spend_key", "connected_at", "seconds", "updated_at")
SELECT s."id", u."spend_key", s."connected_at",
       LEAST(7200, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
           CASE WHEN s."ended_at" IS NOT NULL
                THEN GREATEST(s."ended_at", COALESCE(s."last_seen_at", s."connected_at"))
                ELSE COALESCE(s."last_seen_at", s."connected_at") END
           - s."connected_at")))::INTEGER)),
       CURRENT_TIMESTAMP
FROM "voice_drill_sessions" s
JOIN "users" u ON u."id" = s."user_id"
WHERE s."connected_at" IS NOT NULL AND s."connected_at" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
ON CONFLICT ("session_id") DO NOTHING;
