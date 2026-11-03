/**
 * Whether opening a topic should start its preparation now: the concepts first, then the rest of
 * the topic's chain, notes among it. The topic page does this once: when the topic has no notes,
 * no failed attempt waits for a hand-pressed retry, and the jobs already running on the server
 * have been looked at (a refresh mid-write finds the running job instead of asking for a second
 * one; the server also allows one job per topic and type).
 */
export type AutoStartInput = {
  /** The page is still deciding (it opened without notes and without a failure to retry). */
  preparing: boolean
  /** The running jobs of this course have been fetched. */
  activeChecked: boolean
  /** The preparation has been started from this page already. */
  alreadyStarted: boolean
  notesPresent: boolean
  /** A job of the preparation (concepts, warm-up or notes) is running, found on the server or started here. */
  notesRunning: boolean
  /** AI is unavailable or the allowance is used: the request would be refused, so do not send it. */
  aiBlocked?: boolean
}

/**
 * What opening a topic asks for: its concepts, with the rest of the topic's chain to follow (the
 * AI service queues the warm-up, notes and the other types one after another). A topic that
 * already has concepts gets the first type it is missing instead (see the generate-content route).
 */
export function autoStartRequest(): { contentType: 'concepts'; preferences: { prepare_rest: true; only_if_missing: true } } {
  return { contentType: 'concepts', preferences: { prepare_rest: true, only_if_missing: true } }
}

/** What viewing a topic asks for ahead of time for the next one: its concepts, nothing after them. */
export function prefetchRequest(): { contentType: 'concepts'; preferences: { only_if_missing: true } } {
  return { contentType: 'concepts', preferences: { only_if_missing: true } }
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
