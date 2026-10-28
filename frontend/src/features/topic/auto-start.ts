/**
 * Whether opening a topic should start its notes now. The topic page does this once: when the
 * topic has no notes, no failed attempt waits for a hand-pressed retry, and the jobs already
 * running on the server have been looked at (a refresh mid-write finds the running job instead of
 * asking for a second one; the server also allows one job per topic and type).
 */
export type AutoStartInput = {
  /** The page is still deciding (it opened without notes and without a failure to retry). */
  preparing: boolean
  /** The running jobs of this course have been fetched. */
  activeChecked: boolean
  /** The notes have been started from this page already. */
  alreadyStarted: boolean
  notesPresent: boolean
  /** A notes job is running (found on the server, or started here). */
  notesRunning: boolean
  /** AI is unavailable or the allowance is used: the request would be refused, so do not send it. */
  aiBlocked?: boolean
}

/** 'wait' keeps the generating state up, 'start' sends the request, 'skip' leaves it alone. */
export function autoStartDecision(input: AutoStartInput): 'wait' | 'start' | 'skip' {
  if (!input.preparing) return 'skip'
  // Started from this page already: the request settles on its own (React runs effects twice in
  // development), so keep waiting rather than send it again or drop the generating state early.
  if (input.alreadyStarted || !input.activeChecked) return 'wait'
  if (input.notesPresent || input.notesRunning || input.aiBlocked) return 'skip'
  return 'start'
}
