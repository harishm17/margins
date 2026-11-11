/**
 * Claims a voice session for a turn: one live session per user, and the daily minutes cap. Both are
 * checked and the session is marked connected (first turn) and seen (every turn) in one serializable
 * transaction, so two requests cannot both pass. The turn route calls it on every turn: the cap counts
 * the session's own minutes as they run, so a session that began with a minute left stops when it is used.
 * The same write counts the pause since the last turn as voice time (usage.ts, creditActivity).
 */
import { logServerError } from '@/lib/ops/log'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { spendKeyFor } from '@/lib/account/spend-key-store'
import { creditActivity, dailyVoiceMinutes, isSessionLive, remainingSeconds } from '@/lib/voice/usage'
import { SESSION_TIMING, loadKeptUsage, loadRecentSessions } from '@/lib/voice/usage-query'
import { TURN_CLAIM_STALE_MS, TURN_KEEP_ALIVE_MS } from '@/lib/voice/turn-contract'

export type VoiceClaim =
  | { ok: true; remainingSeconds: number }
  | { ok: false; reason: 'busy' | 'cap'; capMinutes: number }

export async function claimVoiceSession(session: { id: string; userId: string }, now = new Date()): Promise<VoiceClaim> {
  const capMinutes = dailyVoiceMinutes()
  const spendKey = await spendKeyFor(session.userId)
  return prisma.$transaction(
    async (tx): Promise<VoiceClaim> => {
      const [own, recent] = await Promise.all([
        tx.voiceDrillSession.findUniqueOrThrow({ where: { id: session.id }, select: SESSION_TIMING }),
        loadRecentSessions(session.userId, now, tx),
      ])
      if (recent.some((other) => other.id !== session.id && isSessionLive(other, now))) {
        return { ok: false, reason: 'busy', capMinutes }
      }
      // This session as it stands once the turn starts: connected, and with the pause before the turn counted.
      const claimed = { ...own, connectedAt: own.connectedAt ?? now, lastSeenAt: now, ...creditActivity(own, now) }
      const kept = await loadKeptUsage(session.userId, spendKey, now, tx)
      const remaining = remainingSeconds([...recent.filter((other) => other.id !== session.id), claimed], capMinutes, now, kept)
      if (remaining <= 0) return { ok: false, reason: 'cap', capMinutes }
      await tx.voiceDrillSession.update({
        where: { id: session.id },
        data: { connectedAt: claimed.connectedAt, lastSeenAt: now, activeMs: claimed.activeMs, activeAt: claimed.activeAt },
      })
      return { ok: true, remainingSeconds: remaining }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  )
}

/**
 * Undoes the claim of a first turn that failed before the coach said or did anything: the session is not connected
 * and has used nothing.
 */
export async function releaseVoiceSession(sessionId: string): Promise<void> {
  await prisma.voiceDrillSession
    .update({ where: { id: sessionId }, data: { connectedAt: null, lastSeenAt: null, activeMs: 0, activeAt: null } })
    .catch((error) => logServerError('Voice: Could not release the session claim', error))
}

/** True when `error` is the database telling us another request won a serializable race. */
export function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

/**
 * A claim counts while it is fresh. The running turn renews it (keepVoiceTurn); one not renewed for this long was left
 * by a server that died mid-turn. It was a flat three minutes from the start of the turn, which kept a student out of
 * their session for three minutes after a crash and would have let a second turn in on a turn that ran longer.
 */
export const VOICE_TURN_MAX_MS = TURN_CLAIM_STALE_MS

/**
 * Claims the right to run one turn of a session. Two turns at once would each load the same history, and the later
 * write would drop the earlier one. The claim is one conditional update on the session row, so it holds across
 * server processes (the in-memory set it replaces only covered one). False when a turn is already running.
 */
export async function claimVoiceTurn(userId: string, sessionId: string, now = new Date()): Promise<boolean> {
  const claimed = await prisma.voiceDrillSession.updateMany({
    where: {
      id: sessionId,
      userId,
      OR: [{ turnStartedAt: null }, { turnStartedAt: { lt: new Date(now.getTime() - VOICE_TURN_MAX_MS) } }],
    },
    data: { turnStartedAt: now },
  })
  return claimed.count === 1
}

/**
 * Keeps the claim of a running turn fresh, and calls `beat` at the same pace (the route writes a keep-alive line to the
 * reply stream). Returns the function that stops it; call that before the claim is released. Only a claim that is still
 * held is renewed, so a renewal that lands after the release changes nothing.
 */
export function keepVoiceTurn(userId: string, sessionId: string, beat?: () => void, everyMs = TURN_KEEP_ALIVE_MS): () => void {
  const timer = setInterval(() => {
    beat?.()
    void prisma.voiceDrillSession
      .updateMany({ where: { id: sessionId, userId, turnStartedAt: { not: null } }, data: { turnStartedAt: new Date() } })
      .catch((error) => logServerError('Voice: Could not renew the turn claim', error))
  }, everyMs)
  return () => clearInterval(timer)
}

/**
 * Ends the claim of `claimVoiceTurn`. With `counted` (the turn got past `claimVoiceSession`, which counted up to its
 * start), the turn itself is added to the session's voice time. Never throws: the turn is over either way, and a stale
 * claim expires by itself. Reading and then writing is safe here: the claim this ends is what keeps a second turn out,
 * and nothing else writes the counted time.
 */
export async function releaseVoiceTurn(userId: string, sessionId: string, counted = false, now = new Date()): Promise<void> {
  try {
    const session = counted
      ? await prisma.voiceDrillSession.findFirst({ where: { id: sessionId, userId }, select: { activeMs: true, activeAt: true } })
      : null
    await prisma.voiceDrillSession.updateMany({
      where: { id: sessionId, userId },
      // A first turn that failed released the session (releaseVoiceSession): it has no time to add to.
      data: { turnStartedAt: null, ...(session?.activeAt ? creditActivity(session, now, true) : {}) },
    })
  } catch (error) {
    logServerError('Voice: Could not release the turn claim', error)
  }
}
