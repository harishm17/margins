-- Self-serve account deletion keeps the account's spend rows in the ledger, unlinked from it, so
-- the global daily cap (the sum of every row of the day) cannot be lowered by deleting an account.
-- No existing rows change.
--
-- 1. user_id becomes nullable and the foreign key sets it to NULL instead of deleting the row.
-- 2. A trigger applies one rule to every writer of the ledger (the web app's chat route, the AI
--    service's jobs and voice turns): spend recorded for an account that no longer exists is kept
--    with user_id, project_id and source_id cleared, instead of being refused by the foreign key.
--    It locks the user row FOR KEY SHARE, so it waits for a deletion in progress.
-- 3. delete_user_account(id) deletes an account in one statement: it locks the user row FOR UPDATE
--    (which waits for, and then blocks, every ledger insert for that user), unlinks the account's
--    ledger rows, then deletes the row (everything else cascades). Nothing can be written for the
--    account between the unlinking and the delete. Returns false when the account was already gone.
--    Called by the web app (src/server/account.ts). Prisma does not model functions or triggers, so
--    `prisma migrate dev` will not propose dropping them.

-- DropForeignKey
ALTER TABLE "llm_usage_events" DROP CONSTRAINT "llm_usage_events_user_id_fkey";

-- AlterTable
ALTER TABLE "llm_usage_events" ALTER COLUMN "user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Spend for a deleted account is kept, unlinked.
CREATE FUNCTION "llm_usage_events_unlink_deleted_user"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."user_id" IS NOT NULL THEN
        PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR KEY SHARE;
        IF NOT FOUND THEN
            NEW."user_id" := NULL;
            NEW."project_id" := NULL;
            NEW."source_id" := '';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "llm_usage_events_unlink_deleted_user"
    BEFORE INSERT ON "llm_usage_events"
    FOR EACH ROW EXECUTE FUNCTION "llm_usage_events_unlink_deleted_user"();

-- Delete an account: lock it, unlink its spend, delete it.
CREATE FUNCTION "delete_user_account"(p_user_id TEXT) RETURNS BOOLEAN AS $$
BEGIN
    PERFORM 1 FROM "users" WHERE "id" = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    UPDATE "llm_usage_events"
    SET "user_id" = NULL, "project_id" = NULL, "source_id" = ''
    WHERE "user_id" = p_user_id;
    DELETE FROM "users" WHERE "id" = p_user_id;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
