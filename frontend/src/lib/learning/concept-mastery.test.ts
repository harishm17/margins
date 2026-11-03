import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conceptMastery, topicMasteryFromConcepts } from './concept-mastery'
import { replayConcept } from './memory'
import type { EventRow } from './evidence-types'

const TZ = 'America/Chicago'
const chicago = (day: string, time: string) => new Date(`${day}T${time}:00-06:00`)

let seq = 0
function ev(over: Partial<EventRow> = {}): EventRow {
  seq += 1
  return {
    source: 'quiz',
    score: 1,
    assistance: 0,
    confidence: null,
    weight: 1,
    sessionKey: `s${seq}`,
    createdAt: chicago('2026-11-10', '10:00'),
    itemKey: `item${seq}`,
    metadata: {},
    ...over,
  }
}

const mastery = (events: EventRow[], kind: 'concept' | 'judgment', now: Date) =>
  conceptMastery(replayConcept(events, { timeZone: TZ, now }), kind, now)

const D1 = chicago('2026-11-10', '10:00')
const D2 = chicago('2026-11-11', '10:00')

test('one unassisted answer caps at 0.5', () => {
  const r = mastery([ev({ createdAt: D1 })], 'concept', D1)
  assert.ok(Math.abs(r.mastery - 0.5) < 0.01)
  assert.equal(r.label, 'getting_there')
})

test('three good answers reach solid', () => {
  const events = [
    ev({ createdAt: D1 }),
    ev({ createdAt: chicago('2026-11-10', '10:30') }),
    ev({ createdAt: D2 }),
  ]
  const r = mastery(events, 'concept', D2)
  assert.ok(r.mastery >= 0.8)
  assert.equal(r.label, 'solid')
})

test('judgment needs an explanation to pass 0.8', () => {
  const quizzes = [
    ev({ createdAt: D1 }),
    ev({ createdAt: chicago('2026-11-10', '10:30') }),
    ev({ createdAt: D2 }),
  ]
  assert.ok(mastery(quizzes, 'judgment', D2).mastery < 0.8)
  const withRecall = [...quizzes, ev({ source: 'recall', score: 0.8, createdAt: D2 })]
  assert.ok(mastery(withRecall, 'judgment', D2).mastery >= 0.8)
})

test('fading when retrievability drops', () => {
  const events = [
    ev({ createdAt: D1 }),
    ev({ createdAt: chicago('2026-11-10', '10:30') }),
    ev({ createdAt: D2 }),
  ]
  const later = new Date(D2.getTime() + 200 * 24 * 60 * 60 * 1000)
  const r = mastery(events, 'concept', later)
  assert.equal(r.label, 'fading')
  assert.ok(r.retrievability < 0.7)
})

test('inferred when only warmup', () => {
  const r = mastery([ev({ source: 'warmup', score: 0.6, createdAt: D1 })], 'concept', D1)
  assert.equal(r.label, 'inferred')
  assert.equal(r.mastery, 0)
  assert.equal(mastery([], 'concept', D1).label, 'not_started')
})

test('topic mean counts untouched as 0', () => {
  assert.equal(topicMasteryFromConcepts([{ mastery: 1 }, { mastery: 0 }, { mastery: 0.5 }]), 0.5)
  assert.equal(topicMasteryFromConcepts([]), 0)
})

test('three right answers in one sitting stay below solid', () => {
  const events = [
    ev({ createdAt: D1 }),
    ev({ createdAt: chicago('2026-11-10', '10:10') }),
    ev({ createdAt: chicago('2026-11-10', '10:20') }),
  ]
  assert.ok(mastery(events, 'concept', chicago('2026-11-10', '10:30')).mastery < 0.8)
})

test('delayed success on a new item reaches solid', () => {
  const events = [
    ev({ createdAt: D1 }),
    ev({ createdAt: chicago('2026-11-10', '10:10') }),
    ev({ createdAt: chicago('2026-11-10', '10:20') }),
    ev({ createdAt: D2, itemKey: 'brand-new' }),
  ]
  assert.ok(mastery(events, 'concept', D2).mastery >= 0.8)
})

test('delayed success on a repeated item does not count', () => {
  const events = [
    ev({ createdAt: D1, itemKey: 'same' }),
    ev({ createdAt: chicago('2026-11-10', '10:10') }),
    ev({ createdAt: chicago('2026-11-10', '10:20') }),
    ev({ createdAt: D2, itemKey: 'same' }),
  ]
  assert.ok(mastery(events, 'concept', D2).mastery < 0.8)
})

test('answers in one session count as one rating for the cap', () => {
  const events = [
    ev({ createdAt: D1, sessionKey: 'one' }),
    ev({ createdAt: D1, sessionKey: 'one' }),
    ev({ createdAt: D1, sessionKey: 'one' }),
  ]
  const r = mastery(events, 'concept', D1)
  assert.ok(Math.abs(r.mastery - 0.5) < 0.01)
})
