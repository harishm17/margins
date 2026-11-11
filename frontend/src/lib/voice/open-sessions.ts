/**
 * The student's other voice sessions, settled when a new one starts (findings 71, 85 and 128).
 *
 * - A session whose browser went away without ending it (a closed laptop, a crashed tab) is closed as `aborted` at its
 *   last sign of life. It used to stay `active` for good.
 * - A session still open somewhere else: the start is refused before anything is created (`busy`), so a refused start
 *   leaves no empty session behind and uses none of the day's starts. With `takeOver` ("Start here instead") the other
 *   session is ended now; its tab learns on its next turn that the session has ended.
 *
 * The check that holds when two starts race is still `claimVoiceSession`, on the first turn.
 */
import { prisma } from '@/lib/db/prisma'
import { HEARTBEAT_STALE_MS, USAGE_WINDOW_MS, isSessionLive } from '@/lib/voice/usage'

export async function settleOpenSessions(userId: string, options: { takeOver?: boolean } = {}, now = new Date()): Promise<'clear' | 'busy'> {
  const sessions = await prisma.voiceDrillSession.findMany({
    where: { userId, OR: [{ status: 'active' }, { connectedAt: { gte: new Date(now.getTime() - USAGE_WINDOW_MS) } }] },
    select: { id: true, status: true, createdAt: true, connectedAt: true, lastSeenAt: true, endedAt: true },
  })
  let busy = false
  for (const session of sessions) {
    if (isSessionLive(session, now)) {
      if (!options.takeOver) {
        busy = true
        continue
      }
      // Ended now and seen for the last time now, so its heartbeat does not bring it back (the session route, PATCH).
      await prisma.voiceDrillSession.update({
        where: { id: session.id },
        data: { endedAt: now, lastSeenAt: now, ...(session.status === 'active' ? { status: 'aborted' } : {}) },
      })
      continue
    }
    if (session.status !== 'active' || session.endedAt) continue
    // Never ended by its browser. One that never ran a turn is left alone while it may still be starting.
    const lastSign = session.lastSeenAt ?? session.connectedAt
    if (!lastSign && now.getTime() - session.createdAt.getTime() <= HEARTBEAT_STALE_MS) continue
    await prisma.voiceDrillSession.updateMany({
      where: { id: session.id, status: 'active', endedAt: null },
      data: { status: 'aborted', endedAt: lastSign ?? session.createdAt },
    })
  }
  return busy ? 'busy' : 'clear'
}
