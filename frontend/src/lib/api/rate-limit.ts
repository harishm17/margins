import type { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { spendKeyFor } from '@/lib/account/spend-key-store'
import { ApiErrorCode, apiError } from '@/lib/api/errors'

/**
 * Fixed-window limits kept in the database, so every web instance counts the same hits and a deploy does not reset
 * them. A hit is one statement (`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`), so two
 * instances cannot both pass at the edge. There is no in-memory state: a scan test (src/app/api-routes.test.ts) fails
 * on a module-level Map or Set used for limiting in server code.
 *
 * A student's counters are keyed by their spend key (not the user id), so deleting and re-creating the account does
 * not reset them. A caller with no account (the analytics relay) is keyed by address through `checkAddress`.
 */
export type RateLimitResult = { ok: boolean; retryAfterSeconds: number }

export type RateLimiter = {
  /** Records a hit for the student. `ok` is false once they are over the limit in this window. */
  check: (userId: string, now?: number) => Promise<RateLimitResult>
  /** Records a hit for a caller with no account, by address. */
  checkAddress: (address: string, now?: number) => Promise<RateLimitResult>
}

/** Windows older than this are deleted (on about 1 call in 100). The longest limiter window is ten minutes. */
const KEEP_MS = 24 * 60 * 60 * 1000
const PRUNE_ONE_IN = 100

async function hit(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs)
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO rate_limit_hits (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_hits.count + 1
    RETURNING count`
  if (Math.random() * PRUNE_ONE_IN < 1) {
    await prisma.$executeRaw`DELETE FROM rate_limit_hits WHERE window_start < ${new Date(now - KEEP_MS)}`.catch(() => 0)
  }
  if (rows[0].count <= limit) return { ok: true, retryAfterSeconds: 0 }
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000)) }
}

export function createRateLimiter(options: { name: string; limit: number; windowMs: number }): RateLimiter {
  const { name, limit, windowMs } = options
  return {
    async check(userId, now = Date.now()) {
      // A user who is already gone has no key; their id still bounds a request that raced the deletion.
      const subject = (await spendKeyFor(userId)) ?? `user:${userId}`
      return hit(`${name}:${subject}`, limit, windowMs, now)
    },
    checkAddress(address, now = Date.now()) {
      return hit(`${name}:ip:${address}`, limit, windowMs, now)
    },
  }
}

/** The 429 response, in the shape every route uses. `message` is shown to the student. */
export function rateLimitedResponse(result: RateLimitResult, message = 'You are going too fast. Wait a moment, then try again.') {
  const response = apiError(ApiErrorCode.RATE_LIMITED, message, { code: 'RATE_LIMITED', retryable: true }, 429)
  response.headers.set('Retry-After', String(result.retryAfterSeconds))
  return response
}

/** Counts a hit against `limiter`; returns the 429 response to send when the student is over, or null to go on. */
export async function enforceLimit(limiter: RateLimiter, userId: string, message?: string): Promise<NextResponse | null> {
  const result = await limiter.check(userId)
  return result.ok ? null : rateLimitedResponse(result, message)
}

/** The ceiling for any route that changes data and has no limiter of its own: 120 a minute per student. */
export const mutationLimiter = createRateLimiter({ name: 'mutation', limit: 120, windowMs: 60_000 })

export function enforceMutationLimit(userId: string): Promise<NextResponse | null> {
  return enforceLimit(mutationLimiter, userId)
}
