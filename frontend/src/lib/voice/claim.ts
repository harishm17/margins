/**
 * Claims a voice session for a turn: one live session per user, and the daily minutes cap. Both are
 * checked and the session is marked connected (first turn) and seen (every turn) in one serializable
 * transaction, so two requests cannot both pass. The turn route calls it on every turn: the cap counts
 * the session's own minutes as they run, so a session that began with a minute left stops when it is used.
 */
import { logServerError } from '@/lib/ops/log'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { spendKeyFor } from '@/lib/account/spend-key-store'
import { dailyVoiceMinutes, isSessionLive, remainingSeconds } from '@/lib/voice/usage'
import { loadKeptUsage } from '@/lib/voice/usage-query'

export type VoiceClaim =
  | { ok: true; remainingSeconds: number }
  | { ok: false; reason: 'busy' | 'cap'; capMinutes: number }

export async function claimVoiceSession(
  session: { id: string; userId: string; connectedAt: Date | null },
  now = new Date()
): Promise<VoiceClaim> {
  const capMinutes = dailyVoiceMinutes()
  const spendKey = await spendKeyFor(session.userId)
  return prisma.$transaction(
    async (tx): Promise<VoiceClaim> => {
      const recent = await tx.voiceDrillSession.findMany({
        where: {
          userId: session.userId,
          connectedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        select: { id: true, connectedAt: true, lastSeenAt: true, endedAt: true },
      })
      if (recent.some((other) => other.id !== session.id && isSessionLive(other, now))) {
        return { ok: false, reason: 'busy', capMinutes }
      }
      const kept = await loadKeptUsage(session.userId, spendKey, now, tx)
      const remaining = remainingSeconds(recent, capMinutes, now, kept)
      if (remaining <= 0) return { ok: false, reason: 'cap', capMinutes }
      await tx.voiceDrillSession.update({
        where: { id: session.id },
        data: { connectedAt: session.connectedAt ?? now, lastSeenAt: now },
      })
      return { ok: true, remainingSeconds: remaining }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  )
}

/** True when `error` is the database telling us another request won a serializable race. */
export function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

/** A turn still counts as running this long; a claim older than that was left by a server that died mid-turn. */
export const VOICE_TURN_MAX_MS = 3 * 60_000

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

/** Ends the claim of `claimVoiceTurn`. Never throws: the turn is over either way, and a stale claim expires by itself. */
export async function releaseVoiceTurn(userId: string, sessionId: string): Promise<void> {
  await prisma.voiceDrillSession
    .updateMany({ where: { id: sessionId, userId }, data: { turnStartedAt: null } })
    .catch((error) => logServerError('Voice: Could not release the turn claim', error))
}
