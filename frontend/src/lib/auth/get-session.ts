/**
 * Server-side session utilities
 */

import { getServerSession } from 'next-auth'
import { authOptions } from './auth-config'

export interface UserSession {
  user: {
    id: string
    email: string
    name?: string | null
  }
}

// The cross-user test (src/app/api/cross-user.db.test.ts) signs in as a given student here. It cannot be set in production.
let testSession: UserSession | null = null
export function setTestSession(session: UserSession | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setTestSession is for tests')
  testSession = session
}

/** The signed-in student's session, or null. Every route reads the session here (or through requireAuth). */
export async function readSession() {
  if (testSession) return testSession
  return getServerSession(authOptions)
}

/**
 * Get the current session, throw if not authenticated
 * Use this in API routes that require authentication
 */
export async function requireAuth(): Promise<UserSession> {
  const session = await readSession()

  if (!session || !session.user) {
    throw new Error('Unauthorized')
  }

  return session as UserSession
}
