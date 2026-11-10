import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rating } from 'ts-fsrs'
import { gradeFor, replayConcept } from './memory'
import type { EventRow } from './evidence-types'

const TZ = 'America/Chicago'
const NOW = new Date('2026-11-20T12:00:00Z')
const opts = { timeZone: TZ, now: NOW }

// Chicago is UTC-6 in November (CST).
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
    metadata: {},
    ...over,
  }
}

test('gradeFor maps score bands', () => {
  assert.equal(gradeFor({ score: 0.4, allFirstTry: false }), Rating.Again)
  assert.equal(gradeFor({ score: 0.6, allFirstTry: false }), Rating.Hard)
  assert.equal(gradeFor({ score: 0.8, allFirstTry: false }), Rating.Good)
  assert.equal(
    gradeFor({
      score: 0.95,
      confidence: 0.95,
      allFirstTry: true,
    }),
    Rating.Easy
  )
  assert.equal(
    gradeFor({
      score: 0.95,
      confidence: 0.95,
      allFirstTry: false,
    }),
    Rating.Good
  )
  // An unsure right answer caps at Hard.
  assert.equal(
    gradeFor({
      score: 1,
      confidence: 0.3,
      allFirstTry: true,
    }),
    Rating.Hard
  )
})

test('confident wrong sets misconception', () => {
  const state = replayConcept([ev({ score: 0, confidence: 0.9 })], opts)
  assert.ok(state.misconception)
  assert.match(state.misconception!, /Confident but wrong/)
  assert.ok(state.misconceptionAt)
  assert.equal(
    gradeFor({
      score: 0,
      confidence: 0.9,
      allFirstTry: false,
    }),
    Rating.Again
  )
})

test('level 2 and 3 never create a card', () => {
  const state = replayConcept([ev({ assistance: 2 }), ev({ assistance: 3, score: 0 })], opts)
  assert.equal(state.card, null)
  assert.equal(state.dueAt, null)
  assert.equal(state.nAssisted, 2)
  assert.ok(state.lastAssistedAt)
})

test('implicit credit never moves a due date earlier, and keeps a date pulled forward', () => {
  const reviews = ['10', '11', '14', '20'].map((d) => ev({ createdAt: chicago(`2026-11-${d}`, '10:00') }))
  const credit = (day: string, hour = '10') =>
    ev({ source: 'implicit', weight: 0.5, sessionKey: `x${day}`, createdAt: chicago(`2026-11-${day}`, `${hour}:00`), metadata: { direction: 'credit', pathWeight: 0.5 } })
  const before = replayConcept(reviews, opts)
  // Credit an hour after the last review, and a week later: later or equal, never earlier.
  for (const day of ['20', '27']) {
    const after = replayConcept([...reviews, credit(day, '11')], opts)
    assert.ok(after.dueAt!.getTime() >= before.dueAt!.getTime(), `credit on ${day}`)
    assert.ok(after.stability! >= before.stability!)
  }
  // A hint pulled the date to tomorrow: a later credit does not push it back out to the long interval.
  const pulled = ev({ assistance: 3, score: 0, createdAt: chicago('2026-11-21', '09:00') })
  const withCredit = replayConcept([...reviews, pulled, credit('21', '10')], opts)
  assert.ok(withCredit.dueAt!.getTime() < chicago('2026-11-25', '00:00').getTime())
})

test('session collapse makes one review', () => {
  const t = chicago('2026-11-10', '10:00')
  const state = replayConcept(
    [
      ev({ sessionKey: 'a', createdAt: t }),
      ev({ sessionKey: 'a', createdAt: new Date(t.getTime() + 1000) }),
      ev({ sessionKey: 'a', createdAt: new Date(t.getTime() + 2000) }),
    ],
    opts
  )
  assert.equal(state.card!.reps, 1)
})

test('same-day collapse uses student zone', () => {
  // 23:30 and 00:30 Chicago are one hour apart but on different local days.
  const split = replayConcept(
    [
      ev({ createdAt: chicago('2026-11-10', '23:30') }),
      ev({ createdAt: chicago('2026-11-11', '00:30') }),
    ],
    opts
  )
  assert.equal(split.card!.reps, 2)

  const same = replayConcept(
    [
      ev({ score: 1, createdAt: chicago('2026-11-10', '08:00') }),
      ev({ score: 0.4, createdAt: chicago('2026-11-10', '20:00') }),
    ],
    opts
  )
  assert.equal(same.card!.reps, 1)
  assert.equal(same.level0Scores.length, 2)
  assert.equal(same.level0Scores[1].score, 0.4)

  // 20:00 and 23:00 Chicago are on one local day but 02:00 and 05:00 UTC the next: still one review.
  const lateEvening = replayConcept(
    [
      ev({ createdAt: chicago('2026-11-10', '18:30') }),
      ev({ createdAt: chicago('2026-11-10', '23:30') }),
    ],
    opts
  )
  assert.equal(lateEvening.card!.reps, 1)
})

test('replay equals incremental', () => {
  const all = [
    ev({ createdAt: chicago('2026-11-10', '10:00'), sessionKey: 'a' }),
    ev({
      createdAt: chicago('2026-11-10', '10:05'),
      sessionKey: 'a',
      score: 0.4,
    }),
    ev({
      createdAt: chicago('2026-11-11', '10:00'),
      score: 0,
      confidence: 0.9,
    }),
    ev({ createdAt: chicago('2026-11-12', '10:00'), assistance: 3, score: 0 }),
    ev({
      createdAt: chicago('2026-11-13', '10:00'),
      source: 'warmup',
      score: 0.3,
    }),
    ev({ createdAt: chicago('2026-11-15', '10:00'), score: 0.8 }),
    ev({ createdAt: chicago('2026-11-16', '10:00'), source: 'instruction', assistance: 3, score: 0, weight: 0, itemKey: 'instruction:pointer:c' }),
    ev({ createdAt: chicago('2026-11-17', '10:00'), sessionKey: 'z', score: 1 }),
    ev({ createdAt: chicago('2026-11-17', '10:02'), sessionKey: 'z', assistance: 1, score: 0, weight: 0.25, metadata: { idk: true } }),
  ]
  const full = replayConcept(all, opts)
  let incremental = replayConcept([], opts)
  for (let i = 1; i <= all.length; i += 1) incremental = replayConcept(all.slice(0, i), opts)
  assert.deepEqual(incremental, full)
  // Input order does not matter.
  assert.deepEqual(replayConcept([...all].reverse(), opts), full)
})

test('a failure in a mode already reached drops the concept to the layer below that mode', () => {
  const day = (d: string) => chicago(`2026-11-${d}`, '10:00')
  const pass = (itemKey: string, d: string, mode: string) =>
    ev({ itemKey, createdAt: day(d), metadata: { mode } })
  const passed = [pass('a', '10', 'recall'), pass('b', '11', 'discrimination')]
  assert.equal(replayConcept(passed, opts).modeReached, 'composition')

  // Discrimination fails after composition was reached: recall is the weak layer.
  const failedDiscrimination = replayConcept(
    [...passed, ev({ itemKey: 'c', score: 0.2, createdAt: day('12'), metadata: { mode: 'discrimination' } })],
    opts
  )
  assert.equal(failedDiscrimination.modeReached, 'recall')

  // Composition fails: one layer back.
  const failedComposition = replayConcept(
    [...passed, ev({ itemKey: 'c', score: 0.2, createdAt: day('12'), metadata: { mode: 'composition' } })],
    opts
  )
  assert.equal(failedComposition.modeReached, 'discrimination')

  // A recall failure has no layer below it, and a failure in a mode not yet reached changes nothing.
  const failedRecall = replayConcept(
    [...passed, ev({ itemKey: 'c', score: 0.2, createdAt: day('12'), metadata: { mode: 'recall' } })],
    opts
  )
  assert.equal(failedRecall.modeReached, 'composition')
  const early = replayConcept(
    [ev({ itemKey: 'a', score: 0.2, createdAt: day('10'), metadata: { mode: 'composition' } })],
    opts
  )
  assert.equal(early.modeReached, 'recall')
})

test('a success on day 10 after a first answer on day 9 counts as delayed (days compare in order)', () => {
  const state = replayConcept(
    [
      ev({ itemKey: 'a', createdAt: chicago('2026-11-09', '10:00') }),
      ev({ itemKey: 'b', createdAt: chicago('2026-11-10', '10:00') }),
    ],
    opts
  )
  assert.equal(state.firstEvidenceDay, '2026-11-09')
  assert.equal(state.delayedNewSuccess, true)
})

// ---------------------------------------------------------------------------------------------- v3.1 (spec 18.4, 18.5)

test('instruction events change no card, q or due', () => {
  const reviews = ['10', '11'].map((d) => ev({ createdAt: chicago(`2026-11-${d}`, '10:00') }))
  const before = replayConcept(reviews, opts)
  const instruction = ev({ source: 'instruction', assistance: 3, score: 0, weight: 0, itemKey: 'instruction:pointer:c1', createdAt: chicago('2026-11-12', '10:00') })
  const after = replayConcept([...reviews, instruction], opts)
  assert.deepEqual(after.card, before.card)
  assert.equal(after.dueAt?.getTime(), before.dueAt?.getTime())
  assert.deepEqual(after.level0Scores, before.level0Scores)
  assert.equal(after.nAssisted, before.nAssisted)
  assert.equal(after.nUnassisted, before.nUnassisted)
  assert.equal(after.lastEvidenceAt?.getTime(), before.lastEvidenceAt?.getTime())
  assert.deepEqual(after.itemKeysSeen, before.itemKeysSeen)
  assert.equal(after.lastInstructionAt?.getTime(), instruction.createdAt.getTime())
  // Alone, it leaves the concept as untouched as before.
  const alone = replayConcept([instruction], opts)
  assert.equal(alone.card, null)
  assert.equal(alone.lastEvidenceAt, null)
  assert.equal(alone.firstEvidenceDay, null)
  assert.equal(alone.nAssisted, 0)
})

test('warm-up misses never set lastFailAt', () => {
  const state = replayConcept(
    [ev({ source: 'warmup', score: 0 }), ev({ source: 'warmup', score: 0, metadata: { idk: true } })],
    opts
  )
  assert.equal(state.lastFailAt, null)
  assert.equal(state.lastIdkAt, null)
  assert.equal(state.card, null)
})

test('answers given at one moment are replayed in question order, whatever order they were read in', () => {
  // One quiz submitted at once: every answer has the same time, and each names its own mix-up.
  const at = chicago('2026-11-10', '10:00')
  const wrong = (index: number, misconception: string) =>
    ev({ sessionKey: 'one-quiz', itemKey: `quiz:set:${index}`, score: 0, createdAt: at, metadata: { missKind: 'misconception', misconception } })
  const state = replayConcept([wrong(10, 'Thinks the later question'), wrong(2, 'Thinks the earlier question')], opts)
  assert.equal(state.misconception, 'Thinks the earlier question')
})
