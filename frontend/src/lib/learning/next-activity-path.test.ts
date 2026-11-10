import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextActivity, type TopicConceptState, type TopicLearningState } from './next-activity'
import { nextStepWords, pathSteps } from '@/features/topic/path-steps'
import { pathStepFor } from '@/features/topic/activity-copy'

// The path is Warm-up, Read, Recall, Practice, Quiz. These tests walk one topic along it, and check that the
// next activity, the steps the topic offers and the words the Topics list uses all say the same thing at each point.

const at = (iso: string) => new Date(iso)
const NOW = at('2026-11-10T15:00:00Z')
const UP = { ai: 'up', now: NOW, timeZone: 'UTC' } as const

function concept(id: string, overrides: Partial<TopicConceptState> = {}): TopicConceptState {
  return {
    id,
    name: `Concept ${id}`,
    mastery: 0,
    label: 'not_started',
    retrievability: 0,
    misconception: null,
    consecutiveFails: 0,
    nUnassisted: 0,
    hasCard: false,
    hasQuizEvidence: false,
    prerequisiteIds: [],
    band: 1,
    needsInstruction: false,
    easierStepSinceFail: false,
    latestGroupGoodToday: false,
    lastFailAt: null,
    firstClaim: null,
    prerequisiteWeak: false,
    ...overrides,
  }
}

/** A topic that has been opened and prepared, with nothing done on it yet. */
function topic(overrides: Partial<TopicLearningState> = {}): TopicLearningState {
  return {
    concepts: [concept('a'), concept('b')],
    prepared: true,
    practiceDone: false,
    practiceWritten: true,
    warmupReady: true,
    warmupAt: null,
    readAt: null,
    recallAt: null,
    testedOutAt: null,
    triage: null,
    recallGaps: [],
    gapExplainerReadyFor: [],
    explainerVisitedAt: null,
    lastTeachBackAt: null,
    lastHardQuizAt: null,
    hardSetOnHand: false,
    lastExamAt: null,
    nextReviewAt: null,
    hasAnyEvidence: false,
    ...overrides,
  }
}

const kind = (state: TopicLearningState) => nextActivity(state, UP).kind

test('a topic nobody has opened is sent to the topic, not to a step it may not start with', () => {
  const unopened = topic({ prepared: false, concepts: [], warmupReady: false })
  const next = nextActivity(unopened, UP)
  assert.equal(next.kind, 'start')
  // Not "notes", not "reading": the topic names its first step once it is prepared.
  assert.doesNotMatch(next.reason, /notes/i)
  assert.equal(pathStepFor(next.kind), null)
  assert.equal(nextStepWords(next.kind), 'Next: Warm-up')
})

test('a topic with a warm-up bank starts with the warm-up, the same step the path tags', () => {
  const state = topic()
  assert.equal(kind(state), 'warmup')
  const steps = pathSteps({ hasConcepts: true, warmupReady: true, warmupDone: false, readDone: false, preparingConcepts: false })
  assert.deepEqual(steps, ['warmup', 'read', 'recall', 'practice', 'quiz'])
  assert.equal(pathStepFor(kind(state)), 'warmup')
})

test('walking the path: warm-up, read, recall, practice, quiz', () => {
  const warmed = topic({ warmupAt: at('2026-11-10T09:00:00Z') })
  assert.equal(kind(warmed), 'read')
  const read = topic({ warmupAt: at('2026-11-10T09:00:00Z'), readAt: at('2026-11-10T10:00:00Z') })
  assert.equal(kind(read), 'recall')
  // Recall done, practice not: practice comes before the first quiz.
  const recalled = { ...read, recallAt: at('2026-11-10T11:00:00Z') }
  const afterRecall = nextActivity(recalled, UP)
  assert.equal(afterRecall.kind, 'practice')
  assert.match(afterRecall.reason, /practice, then take the quiz/i)
  // Practice done: the quiz.
  assert.equal(kind({ ...recalled, practiceDone: true }), 'quiz')
})

test('recall done, practice done, everything solid: the stretch rotation, not another quiz', () => {
  const solid = topic({
    warmupAt: at('2026-10-01T00:00:00Z'),
    readAt: at('2026-10-01T00:00:00Z'),
    recallAt: at('2026-10-01T00:00:00Z'),
    practiceDone: true,
    hasAnyEvidence: true,
    concepts: [concept('a', { mastery: 0.9, label: 'solid', retrievability: 0.95, nUnassisted: 4, hasCard: true, hasQuizEvidence: true })],
  })
  assert.equal(kind(solid), 'teach_back')
  assert.equal(nextStepWords('teach_back'), 'Next: Explain it back')
})

test('a legacy topic without concepts goes Read, Practice, Quiz, then practice to keep it fresh', () => {
  const legacy = (overrides: Partial<TopicLearningState>) => topic({ concepts: [], warmupReady: false, ...overrides })
  assert.equal(kind(legacy({})), 'read')
  const read = { readAt: at('2026-10-01T00:00:00Z') }
  assert.equal(kind(legacy(read)), 'practice')
  assert.equal(kind(legacy({ ...read, practiceDone: true })), 'quiz')
  assert.equal(kind(legacy({ ...read, practiceDone: true, hasAnyEvidence: true })), 'practice')
  // A topic nobody opened has no concepts either, and is told apart by `prepared`.
  assert.equal(kind(legacy({ prepared: false })), 'start')
  // The steps such a topic offers have no warm-up and no recall.
  assert.deepEqual(pathSteps({ hasConcepts: false, warmupReady: false, warmupDone: false, readDone: false, preparingConcepts: false }), ['read', 'practice', 'quiz'])
})
