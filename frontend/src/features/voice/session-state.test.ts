import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeTurnFailure } from './errors'
import {
  initialSessionState,
  sessionReducer,
  practiceConceptOf,
  summarize,
  type CoachEntry,
  type SessionAction,
  type SessionState,
} from './session-state'

const run = (actions: SessionAction[], from: SessionState = initialSessionState) =>
  actions.reduce(sessionReducer, from)

const live = (): SessionState =>
  run([{ type: 'starting' }, { type: 'started', at: 1_000, style: 'oral_quiz', inputMode: 'voice', speech: 'on', micNotice: null }])

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

})

describe('summarize', () => {
  it('counts graded answers, lists what to revisit once, and reports the length in seconds', () => {
    const state: Pick<SessionState, 'answered' | 'entries' | 'startedAt' | 'endedAt' | 'ideas'> = {
      ideas: [],
      answered: [
        { text: 'Q1', isCorrect: true, score: 1, ungraded: false },
        { text: 'Q2', isCorrect: false, score: 0.5, ungraded: false },
        { text: 'Q2', isCorrect: false, score: 0, ungraded: false, lookLinks: [{ label: 'pp. 4-6', href: '/api/materials/m1/file#page=4' }] },
        { text: 'Q3', isCorrect: false, score: 0, ungraded: true },
      ],
      entries: [{ id: 1, role: 'student', text: 'a', via: 'text' }],
      startedAt: 0,
      endedAt: 20_000,
    }
    const summary = summarize(state)
    assert.equal(summary.answered, 4)
    assert.equal(summary.correct, 1)
    assert.equal(summary.partly, 1)
    assert.equal(summary.score, 1 / 3)
    assert.deepEqual(summary.revisit, [{ text: 'Q2', lookLinks: [{ label: 'pp. 4-6', href: '/api/materials/m1/file#page=4' }] }])
    assert.equal(summary.seconds, 20)
    assert.equal(summary.minutes, 0)
    assert.equal(summary.exchanges, 1)
    assert.equal(summary.typed, 1)
  })

  it('teach-back: the ideas explained, and the ones taught after probes with the pages to look at again', () => {
    const state = run(
      [
        { type: 'idea-done', idea: { name: 'Load factor', outcome: 'explained', conceptId: 'c1', lookAgain: [], lookLinks: [] } },
        { type: 'idea-done', idea: { name: 'Collision', outcome: 'taught', conceptId: 'c2', lookAgain: ['p. 5'], lookLinks: [{ label: 'p. 5', href: '/api/materials/m1/file#page=5' }] } },
      ],
      live()
    )
    const summary = summarize(state)
    assert.deepEqual(summary.explained, ['Load factor'])
    assert.deepEqual(summary.taught, [{ name: 'Collision', conceptId: 'c2', lookAgain: ['p. 5'], lookLinks: [{ label: 'p. 5', href: '/api/materials/m1/file#page=5' }] }])
    assert.equal(run([{ type: 'reset' }], state).ideas.length, 0)
  })

  it('teach-back ended early: the idea that was open and never closed is named, and a closed one is not', () => {
    const open = { kind: 'concept' as const, text: 'Explain "Load factor" in your own words', idea: { name: 'Load factor', conceptId: 'c1' } }
    const early = summarize({ answered: [], entries: [], startedAt: 0, endedAt: 1000, ideas: [], board: open })
    assert.deepEqual(early.unfinished, { name: 'Load factor', conceptId: 'c1' })
    assert.equal(practiceConceptOf(early), 'c1')
    const closed = summarize({ answered: [], entries: [], startedAt: 0, endedAt: 1000, board: open, ideas: [{ name: 'Load factor', outcome: 'explained', conceptId: 'c1', lookAgain: [], lookLinks: [] }] })
    assert.equal(closed.unfinished, null)
    assert.equal(practiceConceptOf(closed), null)
    // Nothing begun: nothing unfinished. A claim on the board (a reading session) is not an idea left open.
    assert.equal(summarize({ answered: [], entries: [], startedAt: 0, endedAt: 1000, ideas: [], board: null }).unfinished, null)
    assert.equal(summarize({ answered: [], entries: [], startedAt: 0, endedAt: 1000, ideas: [], board: { kind: 'claim', text: 'x' } }).unfinished, null)
  })

})

describe('describeTurnFailure', () => {

  // Every code the turn route sends: where the student lands and what the alert offers. Retry only where retrying can
  // work, sign-in only when signed out, and a dead end (ended, not found, out of budget or credit) goes to the summary.
  it('sends every failure to the right place with the right action', () => {
    const table: Array<[string, boolean, 'lobby' | 'summary' | 'continue', 'retry' | 'none' | 'sign-in']> = [
      ['SESSION_ENDED', false, 'summary', 'none'],
      ['ACTIVE_SESSION', false, 'lobby', 'none'],
      ['VOICE_DAILY_LIMIT', false, 'lobby', 'none'],
      ['TURN_IN_PROGRESS', false, 'continue', 'retry'],
      ['RATE_LIMITED', false, 'continue', 'retry'],
      ['LLM_DAILY_BUDGET', false, 'summary', 'none'],
      ['VOICE_UNAVAILABLE', true, 'continue', 'retry'],
      ['LLM_CREDIT_EXHAUSTED', false, 'summary', 'none'],
      ['LLM_UNAVAILABLE', true, 'continue', 'retry'],
      ['LLM_REFUSED', false, 'continue', 'none'],
      ['LLM_REQUEST_REJECTED', false, 'continue', 'none'],
      ['VOICE_TURN_FAILED', false, 'continue', 'none'],
      ['VOICE_TURN_FAILED', true, 'continue', 'retry'],
      ['VOICE_INTERRUPTED', false, 'continue', 'retry'],
      ['VOICE_NOT_SAVED', false, 'continue', 'none'],
      ['UNAUTHORIZED', false, 'continue', 'sign-in'],
      ['NETWORK', true, 'continue', 'retry'],
      ['NOT_FOUND', false, 'summary', 'none'],
    ]
    for (const [code, retryable, fate, action] of table) {
      const out = describeTurnFailure({ code, message: '', retryable })
      assert.equal(out.fate, fate, code)
      assert.equal(out.alert.action, action, code)
      assert.ok(out.alert.title && out.alert.text, `${code} says something`)
    }
  })

})

