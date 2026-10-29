/**
 * Sessions are JWTs, so a token signed before an account was deleted stays valid on every other
 * device until it expires. The jwt callback asks this on every session read: when the account row
 * is gone it throws, and NextAuth then clears the session cookie and answers as signed out, so
 * pages send the browser to /login and API routes answer 401.
 *
 * A database error does not sign anyone out: the token is kept, and the request's own queries
 * fail on their own.
 */

/** The message of the error thrown for a deleted account (the auth logger keeps it out of errors). */
export const ACCOUNT_GONE = 'ACCOUNT_GONE'

export async function assertAccountExists(
  userId: unknown,
  exists: (userId: string) => Promise<boolean>,
  warn: (message: string, error: unknown) => void = console.warn
): Promise<void> {
  if (typeof userId !== 'string' || !userId) return
  let found: boolean
  try {
    found = await exists(userId)
  } catch (error) {
    warn('[AUTH] Could not check that the signed-in account exists; keeping the session:', error)
    return
  }
  if (!found) throw new Error(ACCOUNT_GONE)
}
