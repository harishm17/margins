-- PR 1.8b. Additive only.

-- True on a job the web started for a student's request (lib/jobs/active-jobs.ts, generate-exam). The daily cap on
-- study-material requests counts these rows only: the jobs the AI service chains after them (the rest of a topic's
-- content, topic finding after a file is read) are not the student's requests. Older rows stay false and never count.
ALTER TABLE "processing_jobs" ADD COLUMN "quota_counted" BOOLEAN NOT NULL DEFAULT false;
