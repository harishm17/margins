/**
 * A submitted attempt is flipped to "submitted" first and its grading job is made a moment later (finalizeAttempt, then
 * startGrading). A page that reads the attempt in between finds no job yet, which is grading about to start, not grading
 * that failed: a failed state is a page that never looks again. Past this long with still no job, the start did not happen.
 */
export const GRADING_START_GRACE_MS = 60_000

export const gradingJustSubmitted = (submittedAt: Date, now: Date = new Date()): boolean => now.getTime() - submittedAt.getTime() < GRADING_START_GRACE_MS
