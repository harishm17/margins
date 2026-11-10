import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rating } from 'ts-fsrs'
import { FIRE, implicitEventsFor, type EdgeRow } from './fire'
import { applyImplicit, emptyMemoryState, replayConcept } from './memory'
import type { EventRow } from './evidence-types'

let n = 0
function edge(source: string, target: string, weight: number, over: Partial<EdgeRow> = {}): EdgeRow {
  n += 1
  return {
    id: `e${n}`,
    sourceId: source,
    targetId: target,
    type: 'encompasses',
    weight,
    confidence: 1,
    status: 'confirmed',
    ...over,
  }
}

function ev(over: Partial<EventRow> = {}): EventRow {
  n += 1
  return {
    source: 'quiz',
    score: 1,
    assistance: 0,
    confidence: null,
    weight: 1,
    sessionKey: `s${n}`,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    metadata: {},
    ...over,
  }
}

const implicit = (direction: 'credit' | 'penalty', w: number, at: string) =>
  ev({
    source: 'implicit',
    weight: w,
    createdAt: new Date(at),
    metadata: { direction, pathWeight: w, edgeId: 'x' },
  })

const opts = { timeZone: 'UTC', now: new Date('2026-12-01T00:00:00Z') }
const DAY = 24 * 60 * 60 * 1000

test('credit walks encompasses to depth 3 with multiplied weights', () => {
  const out = implicitEventsFor('a', Rating.Good, [
    edge('a', 'b', 0.5),
    edge('b', 'c', 0.5),
    edge('c', 'd', 0.5),
    edge('d', 'e', 0.5),
  ])
  const w = Object.fromEntries(out.map((o) => [o.targetId, o.pathWeight]))
  assert.deepEqual(w, { b: 0.5, c: 0.25, d: 0.125 })
  assert.ok(out.every((o) => o.direction === 'credit' && o.edgeId))
})

test('stops below min path weight', () => {
  const out = implicitEventsFor('a', Rating.Easy, [edge('a', 'b', 0.25), edge('b', 'c', 0.25)])
  assert.deepEqual(
    out.map((o) => o.targetId),
    ['b']
  )
  assert.ok(FIRE.minPathWeight > 0.0625)
})

test('ignores rejected and low-confidence proposed edges', () => {
  const out = implicitEventsFor('a', Rating.Good, [
    edge('a', 'b', 1, { status: 'rejected' }),
    edge('a', 'c', 1, { status: 'proposed', confidence: 0.6 }),
    edge('a', 'd', 1, { status: 'proposed', confidence: 0.7 }),
    edge('a', 'f', 1, { type: 'prerequisite' }),
  ])
  assert.deepEqual(
    out.map((o) => o.targetId),
    ['d']
  )
})

test('penalty goes to encompassing parents only', () => {
  const edges = [edge('p', 'c', 0.75), edge('c', 'k', 0.5), edge('g', 'p', 0.5)]
  const out = implicitEventsFor('c', Rating.Again, edges)
  assert.deepEqual(
    out.map((o) => [o.targetId, o.direction, o.pathWeight]),
    [['p', 'penalty', 0.75]]
  )
  assert.deepEqual(implicitEventsFor('c', Rating.Hard, edges), [])
})

const first = ev({ createdAt: new Date('2026-11-01T10:00:00Z') })

test('credit moves stability toward S_good', () => {
  const base = replayConcept([first], opts)
  const s0 = base.card!.stability
  const at = '2026-11-04T10:00:00Z'
  const half = applyImplicit(base, implicit('credit', 0.5, at), new Date(at))
  const full = applyImplicit(base, implicit('credit', 1, at), new Date(at))
  assert.ok(full.card!.stability > s0)
  assert.ok(half.card!.stability > s0 && half.card!.stability < full.card!.stability)
  assert.equal(half.stability, half.card!.stability)
  assert.ok(half.dueAt!.getTime() > new Date(at).getTime())
})

test('credit skipped without card or when consecutiveFails >= 1', () => {
  const at = new Date('2026-11-04T10:00:00Z')
  const e = implicit('credit', 0.5, at.toISOString())
  const none = emptyMemoryState()
  assert.equal(applyImplicit(none, e, at), none)
  const failed = replayConcept([ev({ score: 0 })], opts)
  assert.ok(failed.consecutiveFails >= 1 && failed.card)
  assert.equal(applyImplicit(failed, e, at).card!.stability, failed.card!.stability)
  const replayed = replayConcept([ev({ score: 0 }), e], opts)
  assert.equal(replayed.stability, failed.stability)
})

test('penalty shrinks S and pulls due to tomorrow', () => {
  const base = replayConcept([first, ev({ createdAt: new Date('2026-11-03T10:00:00Z') })], opts)
  const at = new Date('2026-11-10T10:00:00Z')
  const out = applyImplicit(base, implicit('penalty', 0.5, at.toISOString()), at)
  assert.ok(Math.abs(out.card!.stability - base.card!.stability * 0.75) < 1e-9)
  assert.equal(out.dueAt!.getTime(), at.getTime() + DAY)
})

test('implicit events are not the student own evidence', () => {
  const at = new Date('2026-11-10T10:00:00Z')
  const withIm = replayConcept(
    [first, { ...implicit('credit', 0.5, at.toISOString()), itemKey: 'quiz:zz' }],
    opts
  )
  const plain = replayConcept([first], opts)
  assert.deepEqual(withIm.lastEvidenceAt, first.createdAt)
  assert.deepEqual(withIm.level0Scores, plain.level0Scores)
  assert.equal(withIm.nUnassisted, plain.nUnassisted)
  assert.deepEqual(withIm.itemKeysSeen, plain.itemKeysSeen)
  assert.equal(withIm.delayedNewSuccess, false)
  assert.equal(withIm.firstEvidenceDay, plain.firstEvidenceDay)
  const only = replayConcept([implicit('credit', 0.5, at.toISOString())], opts)
  assert.equal(only.lastEvidenceAt, null)
  assert.equal(only.card, null)
})

test('the strongest path wins when two paths reach a concept', () => {
  const out = implicitEventsFor('a', Rating.Good, [
    edge('a', 'z', 0.4),
    edge('a', 'm', 0.9),
    edge('m', 'z', 0.9),
  ])
  const z = out.filter((o) => o.targetId === 'z')
  assert.equal(z.length, 1)
  assert.ok(Math.abs(z[0].pathWeight - 0.81) < 1e-9)
})
