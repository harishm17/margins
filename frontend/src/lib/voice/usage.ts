// Voice minutes are metered on the server, on VoiceDrillSession. Two things are kept apart:
//
// Whether the call is open (one open call per student):
//   connectedAt  set on the first voice turn
//   lastSeenAt   refreshed by every turn and by a heartbeat from the open session
//   endedAt      set when the client ends or aborts the session
//
// How much voice time it used (the daily minutes):
//   activeMs     the time counted so far
//   activeAt     the moment it was counted up to
// Time is counted at the start and the end of every turn (creditActivity): a turn counts in full; a pause before the
// next turn counts in full when it is two minutes or less (the student was listening, thinking or answering); a longer
// pause, and the time after the last turn, counts 20 seconds. So a tab left open does not use minutes, whatever its
// heartbeat says.

export const DEFAULT_DAILY_MINUTES = 30
export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000
/** A session with no heartbeat for this long is treated as gone. */
export const HEARTBEAT_STALE_MS = 90_000
/** Nothing legitimate runs longer than this; guards against bad timestamps. */
export const MAX_SESSION_SECONDS = 2 * 60 * 60
/** A pause between two turns counts in full up to this long. The session screen ends a silent spoken session at the same point (silence.ts, VOICE_END_MS). */
export const ACTIVE_PAUSE_MS = 120_000
/** What a longer pause counts, and the most the time after the last turn counts. */
export const PAUSE_GRACE_MS = 20_000

/** Whether the call is open. */
export type SessionLife = {
  connectedAt: Date | null
  lastSeenAt: Date | null
  endedAt: Date | null
}

/** The voice time a session has counted. */
export type ActiveTime = { activeMs: number; activeAt: Date | null }

export type SessionTiming = SessionLife & ActiveTime

/** Reads VOICE_DAILY_MINUTES. A missing or invalid value falls back to the default. */
export function dailyVoiceMinutes(raw: string | undefined = process.env.VOICE_DAILY_MINUTES): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_MINUTES
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DAILY_MINUTES
  return value
}

/**
 * True while the call is open: connected, heard from recently, and not ended since the last
 * heartbeat. A drill that finishes while the call stays open is marked ended, but heartbeats
 * keep arriving after that, so it still counts as live.
 */
export function isSessionLive(session: SessionLife, now: Date): boolean {
  if (!session.connectedAt) return false
  const lastSignOfLife = session.lastSeenAt ?? session.connectedAt
  if (session.endedAt && lastSignOfLife.getTime() <= session.endedAt.getTime()) return false
  return now.getTime() - lastSignOfLife.getTime() <= HEARTBEAT_STALE_MS
}

/**
 * The counted time after a turn starts or ends at `now`. At a start, the pause since the last count is added in full
 * when it is ACTIVE_PAUSE_MS or less, else PAUSE_GRACE_MS. At an end (`turn`), the turn itself is added in full. The
 * first count of a session adds nothing: its time starts there.
 */
export function creditActivity(time: ActiveTime, now: Date, turn = false): { activeMs: number; activeAt: Date } {
  if (!time.activeAt) return { activeMs: time.activeMs, activeAt: now }
  const gap = Math.max(0, now.getTime() - time.activeAt.getTime())
  const counted = turn || gap <= ACTIVE_PAUSE_MS ? gap : PAUSE_GRACE_MS
  return { activeMs: Math.min(time.activeMs + counted, MAX_SESSION_SECONDS * 1000), activeAt: now }
}

/**
 * Seconds of voice time one session used: what it has counted, plus the time since then up to PAUSE_GRACE_MS (to its
 * end when it has ended). The pause in progress counts in full only once the next turn arrives.
 */
export function sessionSeconds(session: SessionTiming, now: Date): number {
  if (!session.connectedAt || !session.activeAt) return 0
  const until = session.endedAt ? Math.min(session.endedAt.getTime(), now.getTime()) : now.getTime()
  const tail = Math.min(Math.max(0, until - session.activeAt.getTime()), PAUSE_GRACE_MS)
  return Math.min(Math.floor((session.activeMs + tail) / 1000), MAX_SESSION_SECONDS)
}

/**
 * What a session used, as the database kept it when the session was last written (voice_usage). It stays when the
 * session is deleted with its course or its account, which is the point: those minutes are not given back.
 */
export type KeptUsage = { sessionId: string; connectedAt: Date; seconds: number }

type IdentifiedSession = SessionTiming & { id?: string }

/**
 * Seconds used by sessions that connected inside the usage window ending now. A session that still exists is measured
 * live (an open call counts up to now); the kept usage of sessions that no longer exist is added as stored.
 */
export function usedSeconds(sessions: IdentifiedSession[], now: Date, kept: KeptUsage[] = []): number {
  const windowStart = now.getTime() - USAGE_WINDOW_MS
  const live = sessions
    .filter((session) => session.connectedAt && session.connectedAt.getTime() >= windowStart)
    .reduce((sum, session) => sum + sessionSeconds(session, now), 0)
  const present = new Set(sessions.map((session) => session.id))
  const gone = kept
    .filter((row) => !present.has(row.sessionId) && row.connectedAt.getTime() >= windowStart)
    .reduce((sum, row) => sum + Math.min(Math.max(0, row.seconds), MAX_SESSION_SECONDS), 0)
  return live + gone
}

export function remainingSeconds(sessions: IdentifiedSession[], capMinutes: number, now: Date, kept: KeptUsage[] = []): number {
  return Math.max(0, Math.round(capMinutes * 60) - usedSeconds(sessions, now, kept))
}
