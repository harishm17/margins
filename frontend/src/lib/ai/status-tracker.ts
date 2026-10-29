/**
 * Keeps the browser's AI status from going backwards. When a request is refused because AI is
 * unavailable, the page marks it unavailable at once (a "report") and asks the server again,
 * skipping its cache. Older answers must not undo that report:
 *
 * - an answer to a request sent before the latest report is dropped;
 * - an answer that may come from the server's cache (a regular poll, a server render) is dropped
 *   until the cache window has passed since the report (it may predate the failure);
 * - a fresh answer asked for after the report is the truth, available or not.
 *
 * Pure: no React, no fetch.
 */

export type StatusTicket = { version: number; fresh: boolean }

/** The browser route; `fresh` skips the server's short cache (src/server/ai-status.ts). */
export const statusUrl = (fresh: boolean) => (fresh ? '/api/ai-status?fresh=1' : '/api/ai-status')

/** The server cache (AI_STATUS_CACHE_MS defaults to 10 s), with a little room. */
export const DEFAULT_CACHE_MS = 15_000

export function createStatusTracker({ cacheMs = DEFAULT_CACHE_MS, now = Date.now }: { cacheMs?: number; now?: () => number } = {}) {
  let version = 0
  let reportedAt = Number.NEGATIVE_INFINITY

  const withinCacheWindow = () => now() - reportedAt < cacheMs

  return {
    /** A request was refused with an unavailable code (or the allowance code). */
    noteReport() {
      version += 1
      reportedAt = now()
    },
    /** Call when a request is sent. */
    begin(fresh: boolean): StatusTicket {
      return { version, fresh }
    },
    /** Whether the answer to that request may replace the status. */
    accepts(ticket: StatusTicket): boolean {
      if (ticket.version !== version) return false
      return ticket.fresh || !withinCacheWindow()
    },
    /** Whether a status rendered on the server (always possibly cached) may replace it. */
    acceptsServerRender(): boolean {
      return !withinCacheWindow()
    },
  }
}
