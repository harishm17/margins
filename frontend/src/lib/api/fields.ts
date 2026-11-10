import { z } from 'zod'

/**
 * Bounded building blocks for request schemas. Every string, list and record in a route schema is bounded (a scan
 * test, src/app/api-routes.test.ts, fails on one that is not), so a body cannot be padded past what the route means
 * to accept. Use these instead of a bare `z.string()`.
 */

/** A string with surrounding space removed and at most `n` characters. Pass `{ min: 1 }` to refuse an empty one. */
export const text = (n: number, options: { min?: number } = {}) => z.string().trim().min(options.min ?? 0).max(n)

/** A string kept exactly as sent (no trim), at most `n` characters: answers, notes and essays where spacing counts. */
export const rawText = (n: number) => z.string().max(n)

/** A row id: a uuid or a cuid, non-empty, at most 100 characters. */
export const id = () => z.string().min(1).max(100)

/** A list of at most `n` items. */
export const list = <T extends z.ZodTypeAny>(item: T, n: number) => z.array(item).max(n)

/** An object keyed by strings of at most `keyMax` characters (an id by default), with at most `n` entries. */
export const record = <T extends z.ZodTypeAny>(value: T, n: number, keyMax = 100) =>
  z.record(z.string().max(keyMax), value).refine((entries) => Object.keys(entries).length <= n, {
    message: `At most ${n} entries`,
  })
