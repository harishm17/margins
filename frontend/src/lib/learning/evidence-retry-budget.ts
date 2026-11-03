// How often owed concept evidence is written again after a failure (quiz attempts and exam submissions).

/** A write that failed is not tried again for this long. */
export const EVIDENCE_RETRY_AFTER_MS = 60 * 60 * 1000
/** After this many failed tries the write is given up on (and logged), so it costs nothing on later visits. */
export const EVIDENCE_MAX_ATTEMPTS = 5

/** The `where` fields of rows that may be tried now: under the cap, and not tried within the last hour. */
export function dueForEvidenceRetry(now: Date = new Date()) {
  return {
    evidenceAttempts: { lt: EVIDENCE_MAX_ATTEMPTS },
    OR: [{ evidenceTriedAt: null }, { evidenceTriedAt: { lt: new Date(now.getTime() - EVIDENCE_RETRY_AFTER_MS) } }],
  }
}

/** Logs when a failure used up the last try. */
export function logIfGivenUp(kind: string, id: string, attemptsAfter: number) {
  if (attemptsAfter >= EVIDENCE_MAX_ATTEMPTS) {
    console.error(`Giving up writing ${kind} evidence for ${id} after ${attemptsAfter} tries; its result is unaffected.`)
  }
}
