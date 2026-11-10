-- How much of a ledger row's input was read from the prompt cache and how much was written to it (A4). Both are
-- already counted in input_tokens; they are kept apart so the cache's effect can be measured per source. Additive only.

-- AlterTable
ALTER TABLE "llm_usage_events" ADD COLUMN "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cache_write_tokens" INTEGER NOT NULL DEFAULT 0;
