import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DAILY_MINUTES,
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
  ...parts,
})

test('the cap defaults to 30 minutes and reads VOICE_DAILY_MINUTES', () => {
  assert.equal(dailyVoiceMinutes(undefined), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes(''), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes('45'), 45)
  assert.equal(dailyVoiceMinutes('0'), 0)
  assert.equal(dailyVoiceMinutes('abc'), DEFAULT_DAILY_MINUTES)
  assert.equal(dailyVoiceMinutes('-5'), DEFAULT_DAILY_MINUTES)
})

test('an ended session counts from connection to end', () => {
  const ended = session({ connectedAt: ago(600), lastSeenAt: ago(310), endedAt: ago(300) })
  assert.equal(sessionSeconds(ended, now), 300)
  // An ended session is not live.
  assert.equal(isSessionLive(session({ connectedAt: ago(60), endedAt: ago(30) }), now), false)
})

test('a live session counts up to now', () => {
  const live = session({ connectedAt: ago(120), lastSeenAt: ago(10) })
  assert.equal(isSessionLive(live, now), true)
  assert.equal(sessionSeconds(live, now), 120)
  // A freshly minted session is live before its first heartbeat.
  assert.equal(isSessionLive(session({ connectedAt: ago(5) }), now), true)
})

test('an unended session with no recent heartbeat counts only to its last heartbeat', () => {
  const gone = session({ connectedAt: ago(3600), lastSeenAt: ago(3000) })
  assert.equal(isSessionLive(gone, now), false)
  assert.equal(sessionSeconds(gone, now), 600)
})

test('only sessions inside the 24 hour window count', () => {
  const old = session({ connectedAt: ago(25 * 3600), endedAt: ago(25 * 3600 - 600) })
  const recent = session({ connectedAt: ago(3600), endedAt: ago(3600 - 240) })
  assert.equal(usedSeconds([old, recent], now), 240)
})

test('remaining time is the cap minus use, never below zero', () => {
  const sessions = [
    session({ connectedAt: ago(7200), endedAt: ago(7200 - 600) }),
    session({ connectedAt: ago(3600), endedAt: ago(3600 - 900) }),
  ]
  assert.equal(remainingSeconds(sessions, 30, now), 30 * 60 - 1500)
  assert.equal(remainingSeconds(sessions, 20, now), 0)
  assert.equal(remainingSeconds([], 0, now), 0)
})

test('a drill that ended while the call stayed open keeps counting while heartbeats arrive', () => {
  const stillOpen = session({ connectedAt: ago(600), lastSeenAt: ago(5), endedAt: ago(300) })
  assert.equal(isSessionLive(stillOpen, now), true)
  assert.equal(sessionSeconds(stillOpen, now), 600)
})

test('minutes kept for a session that no longer exists still count; a session that exists is measured live, not twice', () => {
  const live = { ...session({ connectedAt: ago(3600), endedAt: ago(3600 - 240) }), id: 'a' }
  const kept = [
    { sessionId: 'a', connectedAt: ago(3600), seconds: 9999 },
    { sessionId: 'deleted', connectedAt: ago(1800), seconds: 300 },
    { sessionId: 'old', connectedAt: ago(25 * 3600), seconds: 500 },
  ]
  assert.equal(usedSeconds([live], now, kept), 240 + 300)
  assert.equal(remainingSeconds([live], 30, now, kept), 30 * 60 - 540)
})
