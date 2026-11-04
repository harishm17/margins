-- The browser's id for one send of a question, so a repeated send (a double Enter, a retry after a dropped connection, a reload while the
-- request was in flight) is recognised and never stores the question twice. Null for questions that carry none. Additive only.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "client_request_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_client_request_id_key" ON "chat_messages"("client_request_id");
