import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPracticeEvidence, type PracticeState, type Rung } from '@/lib/learning/practice-evidence'
import { applyTutorEvent, type AppliedState } from './state'

// The path the tutor feeds into practice evidence: a hint opened (or help a reply gave) raises the step's
// rung on the ladder, the browser stores that rung with the step, and the finished step is recorded at its level.

const fresh: AppliedState = { rung: 0, maxRung: 0, attempts: 0, lowEffortTurns: 0, hintsOpened: 0, bareGuesses: 0, sameRungNoProgress: 0 }

/** The evidence of a step solved on the first check after `events` on the tutor's ladder. */
function solvedAfter(events: Parameters<typeof applyTutorEvent>[1][]) {
  const state = events.reduce((current, event) => ({ ...current, ...applyTutorEvent(current, event, {}) }), fresh)
  const next: PracticeState = {
    solvedSteps: [0],
    revealedSteps: [],
    attemptedSteps: [0],
    firstTrySteps: [0],
    maxRungs: { 0: state.maxRung },
    missRungs: {},
  }
  const [event] = buildPracticeEvidence({
    userId: 'u',
    projectId: 'p',
    topicId: 't',
    contentId: 'c',
    problemIndex: 0,
    conceptIdsOf: () => ['k'],
    newlyFinished: [0],
    next,
    sessionKey: 's',
  })
  return { rung: state.maxRung as Rung, event }
}

test('locate hint keeps the step level 0 but capped at 0.6', () => {
  const { rung, event } = solvedAfter([{ type: 'hint_opened', index: 0 }])
  assert.equal(rung, 1)
  assert.equal(event.assistance, 0)
  assert.equal(event.score, 0.6)
  // Orienting and clarifying cost nothing: the step stays uncapped.
  const orient = solvedAfter([{ type: 'clarify' }, { type: 'request' }])
  assert.deepEqual([orient.event.assistance, orient.event.score], [0, 1])
})

test('connect hint makes the step a failed first try', () => {
  const { rung, event } = solvedAfter([{ type: 'hint_opened', index: 0 }, { type: 'hint_opened', index: 1 }])
  assert.equal(rung, 3)
  assert.deepEqual([event.assistance, event.score], [1, 0])
  // Structure, then the worked example, are the same: help above locate fails the first try (spec 18.4).
  assert.deepEqual([solvedAfter([{ type: 'hint_opened', index: 2 }]).event.assistance, solvedAfter([{ type: 'hint_opened', index: 2 }]).event.score], [1, 0])
  assert.equal(solvedAfter([{ type: 'attempt', text: '5', correct: false }, { type: 'show_worked' }]).event.assistance, 1)
})
