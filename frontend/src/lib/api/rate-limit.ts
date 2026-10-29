/**
 * Fixed-window-per-key limiter held in memory.
 *
 * The counts live in one server instance. With several instances (Cloud Run, Vercel) each
 * keeps its own, so the real ceiling is limit x instances. That is enough to slow
 * runaway grading, chat and voice calls; use a shared store if exact limits matter.
 */
export type RateLimiter = {
  /** Records a hit for `key`. `ok` is false once the key is over the limit. */
  check: (key: string, now?: number) => { ok: boolean; retryAfterSeconds: number }
}

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const { limit, windowMs } = options
  const hits = new Map<string, number[]>()

  return {
    check(key, now = Date.now()) {
      // Drop idle keys now and then so the map cannot grow without bound.
      if (hits.size > 5000) {
        for (const [existingKey, times] of hits) {
          if (times[times.length - 1] <= now - windowMs) hits.delete(existingKey)
        }
      }

      const recent = (hits.get(key) ?? []).filter((time) => time > now - windowMs)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) }
      }
      recent.push(now)
      hits.set(key, recent)
      return { ok: true, retryAfterSeconds: 0 }
    },
  }
}

/** The caller's address as the platform proxy reports it. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim() || 'unknown'
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}
