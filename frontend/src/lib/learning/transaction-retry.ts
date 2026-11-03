// A transaction that lost a deadlock (40P01) or a serialization race (40001) is safe to run again
// from the start; Prisma reports both as P2034, or as a raw-query error that carries the SQLSTATE.

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001'])
export const TRANSACTION_ATTEMPTS = 3
// Base wait before the next attempt; the wait grows with the attempt and carries up to the same again
// as jitter, so two writers that deadlocked do not collide again at the same moment.
export const RETRY_BASE_MS = 25

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown }
  if (code === 'P2034') return true
  if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) return true
  if (typeof meta?.code === 'string' && RETRYABLE_SQLSTATES.has(meta.code)) return true
  return typeof message === 'string' && /\b(40P01|40001)\b|deadlock detected/.test(message)
}

// Runs the whole transaction again, up to `attempts` times in all, when it fails on a deadlock or
// serialization error, after a short jittered wait. Any other error, and the last retryable one, passes
// through.
export async function withTransactionRetry<T>(
  run: () => Promise<T>,
  attempts: number = TRANSACTION_ATTEMPTS,
  baseMs: number = RETRY_BASE_MS
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error
      await sleep(baseMs * attempt * (1 + Math.random()))
    }
  }
}
