import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandToConceptEvents, itemKey } from './item-key'
import type { ItemAnswerInput } from './evidence-types'

const base: ItemAnswerInput = {
  userId: 'u1',
  projectId: 'p1',
  topicId: 't1',
  itemKey: 'quiz:s1:3',
  conceptIds: ['c1', 'c2'],
  source: 'quiz',
  score: 1,
  assistance: 0,
  gradedBy: 'rule',
  sessionKey: 'sess1',
}

test('itemKey quiz', () => {
  assert.equal(itemKey({ kind: 'quiz', setId: 's1', index: 3 }), 'quiz:s1:3')
})

test('itemKey practice', () => {
  assert.equal(
    itemKey({ kind: 'practice', contentId: 'c1', problem: 0, step: 2 }),
    'practice:c1:0:2'
  )
})

test('itemKey recall, review, voice, ask, exam', () => {
  assert.equal(itemKey({ kind: 'recall', topicId: 't', objective: 'all' }), 'recall:t:all')
  assert.equal(itemKey({ kind: 'recall', topicId: 't', objective: 1 }), 'recall:t:1')
  assert.equal(itemKey({ kind: 'teach_back', topicId: 't', conceptId: 'c' }), 'teach_back:t:c')
  assert.equal(itemKey({ kind: 'teach_back', topicId: 't', conceptId: 'all' }), 'teach_back:t:all')
  assert.equal(itemKey({ kind: 'review', sessionId: 'r', index: 4 }), 'review:r:4')
  assert.equal(itemKey({ kind: 'voice', sessionId: 'v', index: 0 }), 'voice:v:0')
  assert.equal(itemKey({ kind: 'ask', threadId: 'th', messageId: 'm' }), 'ask:th:m')
  assert.equal(itemKey({ kind: 'exam', examId: 'e', index: 2 }), 'exam:e:2')
})

test('expand weights primary and secondary', () => {
  const events = expandToConceptEvents(base)
  assert.deepEqual(events.map((e) => e.weight), [1, 0.5])
  assert.deepEqual(events.map((e) => e.role), ['primary', 'secondary'])
})

test('expand blames named concept on failure', () => {
  const events = expandToConceptEvents({ ...base, score: 0, blamedConceptId: 'c2' })
  assert.equal(events.find((e) => e.conceptId === 'c2')?.weight, 1)
  assert.equal(events.find((e) => e.conceptId === 'c1')?.weight, 0.25)
})

test('expand blames primary on failure when none named', () => {
  const events = expandToConceptEvents({ ...base, score: 0.2 })
  assert.deepEqual(events.map((e) => e.weight), [1, 0.25])
})

test('model grading scales weight', () => {
  const events = expandToConceptEvents({ ...base, gradedBy: 'model' })
  assert.equal(events[0].weight, 0.7)
  assert.equal(events[1].weight, 0.35)
})

test('no concepts gives no events', () => {
  assert.deepEqual(expandToConceptEvents({ ...base, conceptIds: [] }), [])
})

test('expand drops duplicate concept ids and keeps the first as primary', () => {
  const events = expandToConceptEvents({ ...base, conceptIds: ['c1', 'c2', 'c1', 'c2'] })
  assert.deepEqual(events.map((e) => e.conceptId), ['c1', 'c2'])
  assert.deepEqual(events.map((e) => e.role), ['primary', 'secondary'])
  assert.deepEqual(events.map((e) => e.weight), [1, 0.5])
})

test('expand falls back to the primary when the blamed id is not in the list', () => {
  const events = expandToConceptEvents({ ...base, score: 0, blamedConceptId: 'zz' })
  assert.deepEqual(events.map((e) => e.weight), [1, 0.25])
})

test('expand with three concepts and a secondary blamed gives the others 0.25', () => {
  const events = expandToConceptEvents({
    ...base,
    conceptIds: ['c1', 'c2', 'c3'],
    score: 0,
    blamedConceptId: 'c2',
  })
  assert.deepEqual(events.map((e) => e.weight), [0.25, 1, 0.25])
  assert.deepEqual(events.map((e) => e.role), ['primary', 'secondary', 'secondary'])
})

test('blame is ignored on a success', () => {
  const events = expandToConceptEvents({
    ...base,
    conceptIds: ['c1', 'c2', 'c3'],
    score: 1,
    blamedConceptId: 'c3',
  })
  assert.deepEqual(events.map((e) => e.weight), [1, 0.5, 0.5])
})
