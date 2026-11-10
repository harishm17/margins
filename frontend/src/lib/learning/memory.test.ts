import { test } from 'node:test'
import assert from 'node:assert/strict'
import { default_learning_steps, generatorParameters, Rating } from 'ts-fsrs'
import { FSRS_PARAMS, gradeEventGroup, gradeFor, replayConcept } from './memory'
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

test('event misconception metadata sets misconception', () => {
  const labelled = replayConcept(
    [
      ev({
        score: 0.2,
        confidence: 0.2,
        metadata: { missKind: 'misconception', misconception: 'x' },
      }),
    ],
    opts
  )
  assert.equal(labelled.misconception, 'x')
  const careless = replayConcept(
    [
      ev({
        score: 0,
        confidence: 0.9,
        metadata: { missKind: 'careless', misconception: 'x' },
      }),
    ],
    opts
  )
  assert.equal(careless.misconception, null)
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

test('level 3 pulls due to tomorrow when a card exists', () => {
  // Several good days push the due date well out.
  const reviews = ['10', '11', '14', '20'].map((d) =>
    ev({ createdAt: chicago(`2026-11-${d}`, '10:00') })
  )
  const before = replayConcept(reviews, opts)
  const at = chicago('2026-11-21', '09:00')
  assert.ok(before.dueAt!.getTime() > at.getTime() + 24 * 3600 * 1000)
  const after = replayConcept([...reviews, ev({ assistance: 3, score: 0, createdAt: at })], opts)
  assert.ok(after.dueAt!.getTime() <= at.getTime() + 24 * 3600 * 1000)
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

test('good rating clears misconception', () => {
  const state = replayConcept(
    [
      ev({
        score: 0,
        confidence: 0.9,
        createdAt: chicago('2026-11-10', '10:00'),
      }),
      ev({ score: 0.9, createdAt: chicago('2026-11-12', '10:00') }),
    ],
    opts
  )
  assert.equal(state.misconception, null)
  assert.equal(state.misconceptionAt, null)
  // A Good rating clears the misconception whatever the group holds.
  const day = (d: string) => chicago(`2026-11-${d}`, '10:00')
  const mixedGroup = replayConcept(
    [
      ev({ score: 0, confidence: 0.9, createdAt: day('10') }),
      ev({ sessionKey: 'x', score: 1, weight: 5, createdAt: day('12') }),
      L1({ sessionKey: 'x', weight: 0.25, createdAt: day('12') }),
    ],
    opts
  )
  assert.equal(mixedGroup.misconception, null)
})

test('consecutiveFails counts level-0 Again in a row and resets on Hard', () => {
  const day = (d: string, score: number) =>
    ev({ score, createdAt: chicago(`2026-11-${d}`, '10:00') })
  const twoFails = replayConcept([day('10', 0), day('11', 0.2)], opts)
  assert.equal(twoFails.consecutiveFails, 2)
  const reset = replayConcept([day('10', 0), day('11', 0.2), day('12', 0.6)], opts)
  assert.equal(reset.consecutiveFails, 0)
})

test('warmup sets inferredPrior and no card', () => {
  const state = replayConcept(
    [ev({ source: 'warmup', score: 0.5 }), ev({ source: 'warmup', score: 1 })],
    opts
  )
  assert.equal(state.inferredPrior, 0.75)
  assert.equal(state.card, null)
  assert.equal(state.nUnassisted, 0)
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

test('again never schedules minute-level steps', () => {
  // The library defaults would make a wrong answer due in one minute.
  assert.deepEqual([...default_learning_steps], ['1m', '10m'])
  assert.deepEqual(generatorParameters({}).learning_steps, ['1m', '10m'])
  assert.deepEqual(generatorParameters(FSRS_PARAMS).learning_steps, [])
  assert.equal(generatorParameters(FSRS_PARAMS).enable_short_term, false)

  const at = chicago('2026-11-10', '23:50')
  const state = replayConcept([ev({ score: 0, createdAt: at })], opts)
  const nextLocalMidnight = chicago('2026-11-11', '00:00')
  assert.ok(state.dueAt!.getTime() >= nextLocalMidnight.getTime())
  assert.ok(state.dueAt!.getTime() >= at.getTime() + 24 * 3600 * 1000)

  // A second Again on a later day relearns on a day boundary too.
  const next = replayConcept(
    [ev({ score: 0, createdAt: at }), ev({ score: 0, createdAt: chicago('2026-11-12', '10:00') })],
    opts
  )
  assert.ok(next.dueAt!.getTime() >= chicago('2026-11-13', '10:00').getTime())
})

test('lastEvidenceAt is the latest event of any kind', () => {
  const warmupAt = chicago('2026-11-13', '10:00')
  const state = replayConcept(
    [
      ev({ createdAt: chicago('2026-11-10', '10:00') }),
      ev({ source: 'warmup', score: 0.5, createdAt: warmupAt }),
    ],
    opts
  )
  assert.deepEqual(state.lastEvidenceAt, warmupAt)
  assert.equal(replayConcept([], opts).lastEvidenceAt, null)
})

test('replay derives mode, last rung and miss kind from metadata', () => {
  const state = replayConcept(
    [
      ev({ itemKey: 'a', createdAt: chicago('2026-11-10', '10:00'), metadata: { mode: 'recall' } }),
      ev({
        itemKey: 'b',
        createdAt: chicago('2026-11-11', '10:00'),
        metadata: { mode: 'discrimination', maxRung: 2 },
      }),
      ev({
        itemKey: 'c',
        score: 0.2,
        createdAt: chicago('2026-11-12', '10:00'),
        metadata: { mode: 'composition', maxRung: 3, missKind: 'cue_miss' },
      }),
    ],
    opts
  )
  assert.equal(state.firstEvidenceDay, '2026-11-10')
  assert.deepEqual(state.itemKeysSeen, ['a', 'b', 'c'])
  assert.equal(state.delayedNewSuccess, true)
  // recall and discrimination passed, then composition failed: one step back.
  assert.equal(state.modeReached, 'discrimination')
  assert.equal(state.lastMaxRung, 3)
  assert.equal(state.lastMissKind, 'cue_miss')
  const fresh = replayConcept([], opts)
  assert.equal(fresh.modeReached, 'recall')
  assert.equal(fresh.lastMaxRung, null)
  assert.equal(fresh.lastMissKind, null)
})

test('gradeEventGroup grades a session group the way replay does', async () => {
  const { gradeEventGroup } = await import('./memory')
  assert.equal(gradeEventGroup([ev({ score: 1 })]).grade, Rating.Good)
  assert.equal(gradeEventGroup([ev({ score: 1, confidence: 0.95 })]).grade, Rating.Easy)
  // A level-1 event enters the mean at score 0 (spec 18.4): half of the weight failed, so Hard, not Again.
  assert.equal(gradeEventGroup([ev({ score: 1 }), ev({ score: 1, assistance: 1 })]).grade, Rating.Hard)
  assert.equal(gradeEventGroup([ev({ score: 0.2 })]).grade, Rating.Again)
  // A secondary half-weight event pulls the mean down to a Hard.
  assert.equal(gradeEventGroup([ev({ score: 1, weight: 1 }), ev({ score: 0.3, weight: 1 })]).grade, Rating.Hard)
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

test('lastMissKind clears on a success and is never set from a success event', () => {
  const miss = ev({
    itemKey: 'a',
    score: 0.2,
    createdAt: chicago('2026-11-10', '10:00'),
    metadata: { missKind: 'cue_miss' },
  })
  assert.equal(replayConcept([miss], opts).lastMissKind, 'cue_miss')

  const success = ev({ itemKey: 'b', score: 1, createdAt: chicago('2026-11-11', '10:00') })
  assert.equal(replayConcept([miss, success], opts).lastMissKind, null)

  // A success that carries a missKind label does not set it.
  const labelled = ev({
    itemKey: 'c',
    score: 1,
    createdAt: chicago('2026-11-11', '10:00'),
    metadata: { missKind: 'cue_miss' },
  })
  assert.equal(replayConcept([labelled], opts).lastMissKind, null)
  assert.equal(replayConcept([miss, labelled], opts).lastMissKind, null)
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

test('a warm-up the day before does not start the solid clock: three quizzes the next day are not a delayed success', () => {
  const state = replayConcept(
    [
      ev({ source: 'warmup', itemKey: 'w', score: 0.5, createdAt: chicago('2026-11-09', '10:00') }),
      ev({ itemKey: 'a', createdAt: chicago('2026-11-10', '10:00') }),
      ev({ itemKey: 'b', createdAt: chicago('2026-11-10', '10:05') }),
      ev({ itemKey: 'c', createdAt: chicago('2026-11-10', '10:10') }),
    ],
    opts
  )
  assert.equal(state.firstEvidenceDay, '2026-11-10')
  assert.equal(state.delayedNewSuccess, false)
  // A later day is still what makes it delayed.
  const later = replayConcept(
    [
      ev({ source: 'warmup', itemKey: 'w', createdAt: chicago('2026-11-09', '10:00') }),
      ev({ itemKey: 'a', createdAt: chicago('2026-11-10', '10:00') }),
      ev({ itemKey: 'd', createdAt: chicago('2026-11-12', '10:00') }),
    ],
    opts
  )
  assert.equal(later.delayedNewSuccess, true)
})

// ---------------------------------------------------------------------------------------------- v3.1 (spec 18.4, 18.5)

const L1 = (over: Partial<EventRow> = {}) => ev({ assistance: 1, score: 0, ...over })

test('level-1 event enters the group mean at score 0', () => {
  const g = gradeEventGroup([ev({ score: 1 }), ev({ score: 0.6 }), L1()])
  assert.ok(Math.abs(g.score - 0.5333) < 0.001)
  assert.equal(g.grade, Rating.Hard)
  // Even a stored score on a level-1 event counts as 0.
  assert.equal(gradeEventGroup([ev({ score: 1 }), L1({ score: 1 })]).score, 0.5)
})

test('secondary failure at weight 0.25 moves a little', () => {
  const g = gradeEventGroup([ev({ score: 1, weight: 0.5 }), ev({ score: 0.6, weight: 0.5 }), L1({ weight: 0.25 })])
  assert.ok(Math.abs(g.score - 0.64) < 0.001)
  assert.equal(g.grade, Rating.Hard)
})

test('Easy needs every event a level-0 first-try success', () => {
  const sure = { confidence: 0.95 }
  assert.equal(gradeEventGroup([ev({ score: 1, ...sure }), ev({ score: 1, ...sure })]).grade, Rating.Easy)
  // A level-1 event is a failure inside the group: no Easy, however small its weight.
  assert.notEqual(gradeEventGroup([ev({ score: 1, ...sure, weight: 5 }), L1({ weight: 0.1 })]).grade, Rating.Easy)
  // A level-2 event is not a first try either.
  assert.equal(gradeEventGroup([ev({ score: 1, ...sure }), ev({ score: 1, ...sure, assistance: 2 })]).grade, Rating.Good)
})

test('nUnassisted counts a mixed group', () => {
  const t = chicago('2026-11-10', '10:00')
  const mixed = replayConcept([ev({ sessionKey: 'a', createdAt: t }), L1({ sessionKey: 'a', createdAt: t })], opts)
  assert.equal(mixed.nUnassisted, 1)
  const onlyFailed = replayConcept([L1({ sessionKey: 'b', createdAt: t })], opts)
  assert.equal(onlyFailed.nUnassisted, 0)
  assert.equal(onlyFailed.card!.reps, 1)
})

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

test('lastFailAt from an Again group and from an IDK', () => {
  const day = (d: string, time = '10:00') => chicago(`2026-11-${d}`, time)
  const again = replayConcept([ev({ score: 1, createdAt: day('10') }), ev({ score: 0, createdAt: day('12', '09:00') })], opts)
  assert.equal(again.lastFailAt?.getTime(), day('12', '09:00').getTime())
  assert.equal(again.lastIdkAt, null)
  const idk = replayConcept(
    [ev({ score: 1, createdAt: day('10') }), ev({ assistance: 2, score: 0, createdAt: day('12', '11:00'), metadata: { idk: true } })],
    opts
  )
  assert.equal(idk.lastFailAt?.getTime(), day('12', '11:00').getTime())
  assert.equal(idk.lastIdkAt?.getTime(), day('12', '11:00').getTime())
  const clean = replayConcept([ev({ score: 1, createdAt: day('10') })], opts)
  assert.equal(clean.lastFailAt, null)
  // A Hard group is not a fail.
  assert.equal(replayConcept([ev({ score: 0.6, createdAt: day('10') })], opts).lastFailAt, null)
})

test('lastInstructionAt from a level-3 event and from an instruction event', () => {
  const day = (d: string) => chicago(`2026-11-${d}`, '10:00')
  assert.equal(replayConcept([ev({ createdAt: day('10') })], opts).lastInstructionAt, null)
  assert.equal(replayConcept([ev({ assistance: 3, score: 0, createdAt: day('11') })], opts).lastInstructionAt?.getTime(), day('11').getTime())
  const both = replayConcept(
    [ev({ assistance: 3, score: 0, createdAt: day('11') }), ev({ source: 'instruction', assistance: 3, score: 0, weight: 0, createdAt: day('13') })],
    opts
  )
  assert.equal(both.lastInstructionAt?.getTime(), day('13').getTime())
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

test('pre-v3.1 events replay unchanged except the collapse', () => {
  // Practice before v3.1: a first-try success, a level-2 step (hints before an attempt), two level-3
  // surrenders (worked example before an attempt). None of it is re-scored: the state is what the old replay gave.
  const old = (over: Partial<EventRow>) => ev({ source: 'practice', metadata: {}, ...over })
  const events = [
    old({ score: 1, sessionKey: 'practice:c1:2026-11-10', createdAt: chicago('2026-11-10', '10:00'), itemKey: 'practice:c1:0:0' }),
    old({ score: 1, assistance: 2, sessionKey: 'practice:c1:2026-11-10', createdAt: chicago('2026-11-10', '10:05'), itemKey: 'practice:c1:0:1', metadata: { maxRung: 3 } }),
    old({ score: 0, assistance: 3, sessionKey: 'practice:c1:2026-11-10', createdAt: chicago('2026-11-10', '10:09'), itemKey: 'practice:c1:0:2', metadata: { maxRung: 5, surrendered: true } }),
    old({ score: 0.6, sessionKey: 'practice:c1:2026-11-13', createdAt: chicago('2026-11-13', '10:00'), itemKey: 'practice:c1:1:0', metadata: { maxRung: 0 } }),
    old({ score: 0, assistance: 3, sessionKey: 'practice:c1:2026-11-13', createdAt: chicago('2026-11-13', '10:20'), itemKey: 'practice:c1:1:1', metadata: { maxRung: 5, surrendered: true } }),
  ]
  const state = replayConcept(events, opts)
  // These numbers were taken from the replay before v3.1 and have not changed.
  assert.equal(state.card!.reps, 2)
  assert.equal(state.card!.stability, 9.23487052)
  assert.equal(state.dueAt!.toISOString(), '2026-11-14T16:20:00.000Z')
  assert.equal(state.nUnassisted, 2)
  assert.equal(state.nAssisted, 3)
  assert.deepEqual(state.level0Scores.map((s) => s.score), [1, 0.6])
  assert.equal(state.consecutiveFails, 0)
  assert.equal(state.lastMaxRung, 5)
  assert.equal(state.lastInstructionAt!.toISOString(), '2026-11-13T16:20:00.000Z')
  assert.equal(state.lastFailAt, null)
  // The one thing that changes: an old level-1 event in a group with a success no longer drags the group to 0.
  const withMiss = replayConcept(
    [events[0], old({ score: 0, assistance: 1, sessionKey: 'practice:c1:2026-11-10', createdAt: chicago('2026-11-10', '10:02'), itemKey: 'practice:c1:0:3' })],
    opts
  )
  assert.equal(withMiss.level0Scores[0].score, 0.5)
  assert.equal(withMiss.nUnassisted, 1)
})

test('latestGrade is the grade of the latest group, null without one', () => {
  const day = (d: string) => chicago(`2026-11-${d}`, '10:00')
  assert.equal(replayConcept([], opts).latestGrade, null)
  assert.equal(replayConcept([ev({ source: 'warmup', score: 1 })], opts).latestGrade, null)
  assert.equal(replayConcept([ev({ score: 1, createdAt: day('10') })], opts).latestGrade, Rating.Good)
  assert.equal(replayConcept([ev({ score: 1, createdAt: day('10') }), ev({ score: 0.6, createdAt: day('12') })], opts).latestGrade, Rating.Hard)
  assert.equal(replayConcept([ev({ score: 1, createdAt: day('10') }), ev({ score: 0, createdAt: day('12') })], opts).latestGrade, Rating.Again)
})

test('answers given at one moment are replayed in question order, whatever order they were read in', () => {
  // One quiz submitted at once: every answer has the same time, and each names its own mix-up.
  const at = chicago('2026-11-10', '10:00')
  const wrong = (index: number, misconception: string) =>
    ev({ sessionKey: 'one-quiz', itemKey: `quiz:set:${index}`, score: 0, createdAt: at, metadata: { missKind: 'misconception', misconception } })
  const state = replayConcept([wrong(10, 'Thinks the later question'), wrong(2, 'Thinks the earlier question')], opts)
  assert.equal(state.misconception, 'Thinks the earlier question')
})
