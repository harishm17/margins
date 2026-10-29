import { aiMessage } from '@/lib/ai/messages'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeTurnFailure } from './errors'
import {
  deriveOrbState,
  evaluationBadge,
  initialSessionState,
  sessionReducer,
  summarize,
  type CoachEntry,
  type Evaluation,
  type SessionAction,
  type SessionState,
} from './session-state'

const run = (actions: SessionAction[], from: SessionState = initialSessionState) =>
  actions.reduce(sessionReducer, from)

const live = (): SessionState =>
  run([{ type: 'starting' }, { type: 'started', at: 1_000, style: 'oral_quiz', inputMode: 'voice', speech: 'on', micNotice: null }])

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  isCorrect: true,
  score: 1,
  comment: 'Good.',
  explanation: '',
  ungraded: false,
  ...over,
})

describe('sessionReducer', () => {
  it('goes lobby, starting, live and keeps the limit flag across a reset', () => {
    assert.equal(run([{ type: 'starting' }]).phase, 'starting')
    const state = live()
    assert.equal(state.phase, 'live')
    assert.equal(state.startedAt, 1_000)
    const failed = run([{ type: 'start-failed', lobbyAlert: { kind: 'error', text: 'x' }, limitReached: true }], state)
    assert.equal(failed.phase, 'lobby')
    assert.equal(failed.limitReached, true)
    assert.equal(sessionReducer(failed, { type: 'reset' }).limitReached, true)
  })

  it('builds a coach turn from events and text deltas', () => {
    const state = run(
      [
        { type: 'turn-started' },
        { type: 'question', question: { index: 1, total: 8, text: 'Why BFS?' } },
        { type: 'coach-text', delta: 'Here is ' },
        { type: 'coach-text', delta: 'your question.' },
        { type: 'turn-done' },
      ],
      live()
    )
    assert.equal(state.entries.length, 1)
    const entry = state.entries[0] as CoachEntry
    assert.equal(entry.text, 'Here is your question.')
    assert.equal(entry.streaming, false)
    assert.equal(state.question?.index, 1)
    assert.equal(state.turnActive, false)
  })

  it('attaches the evaluation to the same coach turn and records the answer', () => {
    const state = run(
      [
        { type: 'question', question: { index: 1, total: 2, text: 'Define a hash function' } },
        { type: 'student-said', text: 'it maps keys to buckets' },
        { type: 'turn-started' },
        { type: 'evaluation', evaluation: evaluation({ isCorrect: false, score: 0.5 }) },
        { type: 'coach-text', delta: 'Close.' },
        { type: 'turn-done' },
      ],
      live()
    )
    const coach = state.entries[1] as CoachEntry
    assert.equal(coach.role, 'coach')
    assert.equal(coach.evaluation?.score, 0.5)
    assert.deepEqual(state.answered, [{ text: 'Define a hash function', isCorrect: false, score: 0.5, ungraded: false }])
  })

  it('drops an empty coach entry when a turn fails before anything arrived, and shows the alert', () => {
    const alert = describeTurnFailure({ code: 'LLM_UNAVAILABLE', message: '', retryable: true }).alert
    const state = run([{ type: 'turn-started' }, { type: 'turn-failed', alert }], live())
    assert.equal(state.entries.length, 0)
    // The shared words for a busy AI (lib/ai/messages), as on every other surface.
    assert.equal(state.alert?.title, aiMessage('LLM_UNAVAILABLE').title)
    assert.equal(state.turnActive, false)
  })

  it('keeps partial coach text when a turn fails and clears the alert on the next student turn', () => {
    const alert = describeTurnFailure({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }).alert
    let state = run([{ type: 'turn-started' }, { type: 'coach-text', delta: 'Half a sen' }, { type: 'turn-failed', alert }], live())
    assert.equal((state.entries[0] as CoachEntry).text, 'Half a sen')
    assert.ok(state.alert)
    state = sessionReducer(state, { type: 'student-said', text: 'hello' })
    assert.equal(state.alert, null)
  })

  it('marks an interrupted coach turn when the student barges in', () => {
    const state = run([{ type: 'turn-started' }, { type: 'coach-text', delta: 'Each level is' }, { type: 'speaking', on: true }, { type: 'turn-aborted' }], live())
    const coach = state.entries[0] as CoachEntry
    assert.equal(coach.interrupted, true)
    assert.equal(coach.streaming, false)
    assert.equal(state.speaking, false)
  })

  it('flags completion without leaving the live phase until finish', () => {
    let state = run([{ type: 'turn-started' }, { type: 'session-complete' }, { type: 'coach-text', delta: 'Goodbye.' }, { type: 'turn-done' }], live())
    assert.equal(state.complete, true)
    assert.equal(state.phase, 'live')
    state = sessionReducer(state, { type: 'finish', reason: 'complete', at: 61_000 })
    assert.equal(state.phase, 'summary')
    assert.equal(state.endReason, 'complete')
  })

  it('switching input mode clears the pause and the interim text', () => {
    const state = run([{ type: 'mic-paused', paused: true }, { type: 'interim', text: 'um' }, { type: 'input-mode', mode: 'text' }], live())
    assert.equal(state.inputMode, 'text')
    assert.equal(state.micPaused, false)
    assert.equal(state.interim, '')
  })

  it('keeps a mic notice when switching to text and clears it when voice comes back', () => {
    let state = run([{ type: 'input-mode', mode: 'text', micNotice: 'denied' }], live())
    assert.equal(state.micNotice, 'denied')
    state = sessionReducer(state, { type: 'input-mode', mode: 'voice' })
    assert.equal(state.micNotice, null)
  })
})

describe('deriveOrbState', () => {
  const base = { phase: 'live' as const, inputMode: 'voice' as const, micPaused: false, speaking: false, turnActive: false }

  it('listens while the mic is on and nothing else is happening', () => {
    assert.equal(deriveOrbState(base), 'listening')
  })

  it('thinks while a turn is open and speaks while audio plays', () => {
    assert.equal(deriveOrbState({ ...base, turnActive: true }), 'thinking')
    assert.equal(deriveOrbState({ ...base, turnActive: true, speaking: true }), 'speaking')
  })

  it('is paused with the mic off, idle in text mode, and idle outside a live session', () => {
    assert.equal(deriveOrbState({ ...base, micPaused: true }), 'paused')
    assert.equal(deriveOrbState({ ...base, inputMode: 'text' }), 'idle')
    assert.equal(deriveOrbState({ ...base, phase: 'lobby' }), 'idle')
  })

  it('shows thinking and speaking even when the mic is paused', () => {
    assert.equal(deriveOrbState({ ...base, micPaused: true, turnActive: true }), 'thinking')
  })
})

describe('evaluationBadge', () => {
  it('maps correct, partly, not quite and ungraded', () => {
    assert.deepEqual(evaluationBadge({ isCorrect: true, score: 1, ungraded: false }), { label: 'Correct', tone: 'accent' })
    assert.deepEqual(evaluationBadge({ isCorrect: false, score: 0.5, ungraded: false }), { label: 'Partly', tone: 'warning' })
    assert.deepEqual(evaluationBadge({ isCorrect: false, score: 0.1, ungraded: false }), { label: 'Not quite', tone: 'danger' })
    assert.deepEqual(evaluationBadge({ isCorrect: false, score: 0, ungraded: true }), { label: 'Noted', tone: 'neutral' })
  })
})

describe('summarize', () => {
  it('counts graded answers, lists what to revisit once, and rounds minutes up to one', () => {
    const state: Pick<SessionState, 'answered' | 'entries' | 'startedAt' | 'endedAt'> = {
      answered: [
        { text: 'Q1', isCorrect: true, score: 1, ungraded: false },
        { text: 'Q2', isCorrect: false, score: 0.5, ungraded: false },
        { text: 'Q2', isCorrect: false, score: 0, ungraded: false },
        { text: 'Q3', isCorrect: false, score: 0, ungraded: true },
      ],
      entries: [{ id: 1, role: 'student', text: 'a' }],
      startedAt: 0,
      endedAt: 20_000,
    }
    const summary = summarize(state)
    assert.equal(summary.answered, 4)
    assert.equal(summary.correct, 1)
    assert.equal(summary.partly, 1)
    assert.equal(summary.score, 1 / 3)
    assert.deepEqual(summary.revisit, ['Q2'])
    assert.equal(summary.minutes, 1)
    assert.equal(summary.exchanges, 1)
  })

  it('has no score when nothing was graded', () => {
    const summary = summarize({ answered: [], entries: [], startedAt: null, endedAt: null })
    assert.equal(summary.score, null)
    assert.equal(summary.answered, 0)
  })
})

describe('describeTurnFailure', () => {
  const codes = [
    'SESSION_ENDED',
    'ACTIVE_SESSION',
    'VOICE_DAILY_LIMIT',
    'TURN_IN_PROGRESS',
    'RATE_LIMITED',
    'LLM_DAILY_BUDGET',
    'VOICE_UNAVAILABLE',
    'LLM_NOT_CONFIGURED',
    'LLM_AUTH_FAILED',
    'LLM_CREDIT_EXHAUSTED',
    'LLM_RATE_LIMITED',
    'LLM_UNAVAILABLE',
    'LLM_REFUSED',
    'LLM_REQUEST_REJECTED',
    'LLM_BAD_OUTPUT',
    'VOICE_TURN_FAILED',
    'VOICE_INTERRUPTED',
    'VOICE_NOT_SAVED',
    'UNAUTHORIZED',
    'NETWORK',
    'NOT_FOUND',
    'SOMETHING_NEW',
  ]

  it('has friendly copy without dashes or exclamation marks for every code', () => {
    for (const code of codes) {
      const { alert } = describeTurnFailure({ code, message: 'Server text.', retryable: true })
      const copy = `${alert.title} ${alert.text}`
      assert.ok(alert.title.length > 0 && alert.text.length > 0, code)
      assert.doesNotMatch(copy, /[–—!]/, code)
    }
  })

  it('routes first-turn blockers to the lobby and dead ends to the summary', () => {
    assert.equal(describeTurnFailure({ code: 'ACTIVE_SESSION', message: '', retryable: false }).fate, 'lobby')
    const limit = describeTurnFailure({ code: 'VOICE_DAILY_LIMIT', message: '', retryable: false })
    assert.equal(limit.fate, 'lobby')
    assert.equal(limit.limitReached, true)
    assert.equal(describeTurnFailure({ code: 'SESSION_ENDED', message: '', retryable: false }).fate, 'summary')
    assert.equal(describeTurnFailure({ code: 'LLM_DAILY_BUDGET', message: '', retryable: false }).fate, 'summary')
  })

  it('offers retry only where retrying makes sense', () => {
    assert.equal(describeTurnFailure({ code: 'LLM_UNAVAILABLE', message: '', retryable: true }).alert.action, 'retry')
    assert.equal(describeTurnFailure({ code: 'LLM_REFUSED', message: '', retryable: false }).alert.action, 'none')
    assert.equal(describeTurnFailure({ code: 'VOICE_TURN_FAILED', message: '', retryable: false }).alert.action, 'none')
    assert.equal(describeTurnFailure({ code: 'UNAUTHORIZED', message: '', retryable: false }).alert.action, 'sign-in')
  })

  it('falls back to the server message for an unknown code', () => {
    assert.equal(describeTurnFailure({ code: 'SOMETHING_NEW', message: 'Server text.', retryable: false }).alert.text, 'Server text.')
  })
})
