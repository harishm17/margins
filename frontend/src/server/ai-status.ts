/**
 * getAiStatus: whether AI features can be used now, and the user's allowance for today, from the
 * AI service's GET /status/ai. Every route that starts model work asks it first (see
 * lib/api/ai-preflight), and so do the banner and the AI buttons (through /api/ai-status).
 *
 * Answers are cached for AI_STATUS_CACHE_MS (10 s by default) per user, so a busy page does not
 * ask on every render; the AI service refuses model work by the same record anyway. An AI service
 * that cannot be reached reads as unavailable (AI_UNREACHABLE) and is not cached.
 */

import { aiServiceHeaders } from '@/lib/ai-service/headers'
import { parseStatusResponse, unreachableStatus, type AiStatusDetails } from '@/lib/ai/status'

export type { AiStatusDetails } from '@/lib/ai/status'

const DEFAULT_CACHE_MS = 10_000

const cache = new Map<string, { at: number; value: AiStatusDetails }>()

function cacheMs(): number {
  const value = Number(process.env.AI_STATUS_CACHE_MS)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_MS
}

type Options = {
  /** Skip the cache (a route about to start model work after a recent refusal). */
  fresh?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

export async function getAiStatus(userId?: string | null, options: Options = {}): Promise<AiStatusDetails> {
  const { fresh = false, fetchImpl = fetch, now = Date.now } = options
  const key = userId ?? ''
  const hit = cache.get(key)
  if (!fresh && hit && now() - hit.at < cacheMs()) return hit.value

  const base = process.env.AI_SERVICE_URL || 'http://localhost:8000'
  const query = userId ? `?user_id=${encodeURIComponent(userId)}` : ''
  let value: AiStatusDetails
  try {
    const response = await fetchImpl(`${base}/status/ai${query}`, {
      headers: aiServiceHeaders(),
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`status ${response.status}`)
    value = parseStatusResponse(await response.json())
  } catch (error) {
    console.error('[AI STATUS] The AI service could not be reached:', error)
    cache.delete(key)
    return unreachableStatus()
  }
  cache.set(key, { at: now(), value })
  // Keep the map small: it only needs the recent askers.
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

/** Forget cached answers (tests). */
export function clearAiStatusCache() {
  cache.clear()
}
