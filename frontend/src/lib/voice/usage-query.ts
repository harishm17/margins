import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { spendKeyFor } from '@/lib/account/spend-key-store'
import {
  USAGE_WINDOW_MS,
  dailyVoiceMinutes,
  isSessionLive,
  remainingSeconds,
  usedSeconds,
  type KeptUsage,
} from './usage'

type Client = Pick<Prisma.TransactionClient, 'voiceDrillSession' | '$queryRaw'>

/** Sessions that connected inside the usage window. */
export async function loadRecentSessions(userId: string, now: Date, client: Client = prisma) {
  return client.voiceDrillSession.findMany({
    where: {
      userId,
      connectedAt: { gte: new Date(now.getTime() - USAGE_WINDOW_MS) },
    },
    select: { id: true, connectedAt: true, lastSeenAt: true, endedAt: true },
  })
}

/**
 * What the person's sessions in the window used, as kept by the database (voice_usage): by spend key, so sessions of
 * an earlier account, and sessions deleted with their course, still count. A session of this user is also found by
 * its id, for an account whose key is not stored on every row yet.
 */
export async function loadKeptUsage(
  userId: string,
  spendKey: string | null,
  now: Date,
  client: Client = prisma
): Promise<KeptUsage[]> {
  const since = new Date(now.getTime() - USAGE_WINDOW_MS)
  const rows = await client.$queryRaw<{ session_id: string; connected_at: Date; seconds: number }[]>`
    SELECT v.session_id, v.connected_at, v.seconds
    FROM voice_usage v
    WHERE v.connected_at >= ${since}
      AND (v.spend_key = ${spendKey}
           OR v.session_id IN (SELECT id FROM voice_drill_sessions WHERE user_id = ${userId}))`
  return rows.map((row) => ({ sessionId: row.session_id, connectedAt: row.connected_at, seconds: row.seconds }))
}

export async function getVoiceUsage(userId: string, now = new Date()) {
  const capMinutes = dailyVoiceMinutes()
  const spendKey = await spendKeyFor(userId)
  const [sessions, kept] = await Promise.all([loadRecentSessions(userId, now), loadKeptUsage(userId, spendKey, now)])
  return {
    dailyMinutes: capMinutes,
    usedSeconds: usedSeconds(sessions, now, kept),
    remainingSeconds: remainingSeconds(sessions, capMinutes, now, kept),
    hasLiveSession: sessions.some((session) => isSessionLive(session, now)),
  }
}
