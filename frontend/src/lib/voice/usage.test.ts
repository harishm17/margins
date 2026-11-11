import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_PAUSE_MS,
  DEFAULT_DAILY_MINUTES,
  PAUSE_GRACE_MS,
  creditActivity,
  dailyVoiceMinutes,
  isSessionLive,
  remainingSeconds,
  sessionSeconds,
  usedSeconds,
  type SessionTiming,
} from './usage'

const now = new Date('2026-10-21T12:00:00Z')
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)
const session = (parts: Partial<SessionTiming>): SessionTiming => ({
  connectedAt: null,
  lastSeenAt: null,
  endedAt: null,
  activeMs: 0,
  activeAt: null,
  ...parts,
})
/** A session that connected `connected` seconds ago, counted `used` seconds, and ended right after its last turn. */
const ended = (connected: number, used: number): SessionTiming =>
  session({ connectedAt: ago(connected), lastSeenAt: ago(connected - used), endedAt: ago(connected - used), activeMs: used * 1000, activeAt: ago(connected - used) })

test('the cap defaults to 30 minutes and reads VOICE_DAILY_MINUTES', () => {
  assert.equal(dailyVoiceMinutes(undefined), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes(''), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes('45'), 45)
  assert.equal(dailyVoiceMinutes('0'), 0)
  assert.equal(dailyVoiceMinutes('abc'), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes('-5'), DEFAULT_DAILY_MINUTES)
})

test('a session is live while its heartbeat is fresh and it has not been ended since', () => {
  assert.equal(isSessionLive(session({ connectedAt: ago(120), lastSeenAt: ago(10) }), now), true)
  // A freshly minted session is live before its first heartbeat.
  assert.equal(isSessionLive(session({ connectedAt: ago(5) }), now), true)
  assert.equal(isSessionLive(session({ connectedAt: ago(60), endedAt: ago(30) }), now), false)
  assert.equal(isSessionLive(session({ connectedAt: ago(3600), lastSeenAt: ago(3000) }), now), false)
  // A drill that ended while the call stayed open is live while heartbeats arrive.
  assert.equal(isSessionLive(session({ connectedAt: ago(600), lastSeenAt: ago(5), endedAt: ago(300) }), now), true)
})

test('a turn counts in full, a short pause before the next turn counts in full, a long one counts the grace (finding 71)', () => {
  // The first turn starts: the clock starts there.
  let time = creditActivity({ activeMs: 0, activeAt: null }, ago(300))
  assert.deepEqual(time, { activeMs: 0, activeAt: ago(300) })
  // It ends 8 s later.
  time = creditActivity(time, ago(292), true)
  assert.equal(time.activeMs, 8000)
  // The student answers 50 s later: listening and answering count.
  time = creditActivity(time, ago(242))
  assert.equal(time.activeMs, 58_000)
  // A turn that ran long still counts whole.
  time = creditActivity(time, ago(242 - 130), true)
  assert.equal(time.activeMs, 188_000)
  // Then nothing for a second over two minutes: the pause counts the grace, not its length.
  const back = new Date(time.activeAt.getTime() + ACTIVE_PAUSE_MS + 1000)
  assert.equal(creditActivity(time, back).activeMs, 188_000 + PAUSE_GRACE_MS)
})

test('a tab left open uses the grace and no more, whatever its heartbeat says', () => {
  // One 10 s turn twenty minutes ago; the tab still sends heartbeats.
  const open = session({ connectedAt: ago(1210), lastSeenAt: ago(5), activeMs: 10_000, activeAt: ago(1200) })
  assert.equal(isSessionLive(open, now), true)
  assert.equal(sessionSeconds(open, now), 30)
  // A pause in progress counts as it runs, up to the grace.
  assert.equal(sessionSeconds(session({ connectedAt: ago(20), activeMs: 10_000, activeAt: ago(7) }), now), 17)
  // Ended 5 s after its last turn: those 5 s.
  assert.equal(sessionSeconds(session({ connectedAt: ago(600), endedAt: ago(585), activeMs: 10_000, activeAt: ago(590) }), now), 15)
  // Created and never connected: nothing.
  assert.equal(sessionSeconds(session({}), now), 0)
})

test('only sessions inside the 24 hour window count', () => {
  assert.equal(usedSeconds([ended(25 * 3600, 600), ended(3600, 240)], now), 240)
})

test('remaining time is the cap minus use, never below zero', () => {
  const sessions = [ended(7200, 600), ended(3600, 900)]
  assert.equal(remainingSeconds(sessions, 30, now), 30 * 60 - 1500)
  assert.equal(remainingSeconds(sessions, 20, now), 0)
  assert.equal(remainingSeconds([], 0, now), 0)
})

test('minutes kept for a session that no longer exists still count; a session that exists is measured live, not twice', () => {
  const live = { ...ended(3600, 240), id: 'a' }
  const kept = [
    { sessionId: 'a', connectedAt: ago(3600), seconds: 9999 },
    { sessionId: 'deleted', connectedAt: ago(1800), seconds: 300 },
    { sessionId: 'old', connectedAt: ago(25 * 3600), seconds: 500 },
  ]
  assert.equal(usedSeconds([live], now, kept), 240 + 300)
  assert.equal(remainingSeconds([live], 30, now, kept), 30 * 60 - 540)
})
