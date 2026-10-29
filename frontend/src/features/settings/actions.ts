'use server'

import { cookies } from 'next/headers'
import { confirmsDeletion, AccountDeletionError } from '@/lib/account/deletion'
import { deleteUserAccount } from '@/server/account'
import { getSessionUser } from '@/server/session'

export type DeleteAccountResult = { ok: true } | { ok: false; error: 'signed_out' | 'not_confirmed' | 'failed' }

/** NextAuth's session cookie, chunked (.0, .1, ...) when the token is long. */
const SESSION_COOKIE = /^(__Secure-)?next-auth\.session-token(\.\d+)?$/

/**
 * Deletes the signed-in student's account after they typed the confirmation word, then clears the
 * session cookie in this browser. Other browsers are signed out by the jwt callback, which refuses
 * a token whose account is gone. Safe to call again after a failure: it finishes what is left.
 */
export async function deleteAccountAction(confirmation: string): Promise<DeleteAccountResult> {
  const user = await getSessionUser()
  if (!user) return { ok: false, error: 'signed_out' }
  if (typeof confirmation !== 'string' || !confirmsDeletion(confirmation)) return { ok: false, error: 'not_confirmed' }

  try {
    await deleteUserAccount(user.id)
  } catch (error) {
    if (!(error instanceof AccountDeletionError)) console.error(`[ACCOUNT] Deleting account ${user.id} failed:`, error)
    return { ok: false, error: 'failed' }
  }

  const jar = await cookies()
  for (const cookie of jar.getAll()) {
    if (SESSION_COOKIE.test(cookie.name)) {
      jar.set(cookie.name, '', { maxAge: 0, path: '/', secure: cookie.name.startsWith('__Secure-'), httpOnly: true, sameSite: 'lax' })
    }
  }
  return { ok: true }
}
