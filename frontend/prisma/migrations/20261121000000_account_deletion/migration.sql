-- Self-serve account deletion keeps the account's spend rows in the ledger, unlinked from it, so
-- the global daily cap (the sum of every row of the day) cannot be lowered by deleting an account.
-- user_id becomes nullable and the foreign key sets it to NULL instead of deleting the row. The
-- web app also clears project_id and source_id on those rows (src/server/account/delete-account.ts).
-- No data changes here: existing rows keep their user.

-- DropForeignKey
ALTER TABLE "llm_usage_events" DROP CONSTRAINT "llm_usage_events_user_id_fkey";

-- AlterTable
ALTER TABLE "llm_usage_events" ALTER COLUMN "user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
