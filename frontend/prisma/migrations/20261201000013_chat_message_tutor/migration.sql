-- What Ask tutored on one assistant message: its route and the check question card (with its answer, which stays on the server). Additive only.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "tutor" JSONB;
