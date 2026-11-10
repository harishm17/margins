/**
 * Claims a voice session on its first turn: one live session per user, and the daily minutes
 * cap. Both are checked and the session is marked connected in one serializable transaction,
 * so two requests cannot both pass.
 */
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
