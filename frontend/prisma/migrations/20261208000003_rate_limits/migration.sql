-- PR 1.9b (OPS-M1, web half). Additive only.

-- Fixed-window request counters shared by every web instance. The key is "<limiter name>:<spend key>" for a student
-- (or "<limiter name>:ip:<address>" for a visitor with no account); window_start is the start of the window the hit
-- fell in. One statement increments a counter, so two instances cannot both pass at the edge. Old windows are pruned
-- by the limiter itself. No foreign key: a counter outlives the account it counted, like the spend key.
CREATE TABLE "rate_limit_hits" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("key", "window_start")
);

CREATE INDEX "rate_limit_hits_window_start_idx" ON "rate_limit_hits"("window_start");
