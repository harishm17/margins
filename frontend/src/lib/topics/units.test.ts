import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalTopicOrder, cleanPrerequisites, groupTopicsByUnit, reachesPrerequisite, unitMastery } from './units'

const unit = (id: string, orderIndex: number) => ({ id, orderIndex, title: id })
const topic = (id: string, unitId: string | null, orderIndex: number) => ({ id, unitId, orderIndex })

test('topics are grouped under their units, units and topics in order', () => {
  const units = [unit('w2', 1), unit('w1', 0)]
  const topics = [topic('c', 'w2', 3), topic('a', 'w1', 0), topic('b', 'w1', 1), topic('d', 'w2', 2)]
  const groups = groupTopicsByUnit(topics, units)
  assert.deepEqual(groups.map((g) => [g.unit?.id, g.topics.map((t) => t.id)]), [
    ['w1', ['a', 'b']],
    ['w2', ['d', 'c']],
  ])
})

test('topics of no unit, or of an unknown unit, come last in a headerless group', () => {
  const groups = groupTopicsByUnit([topic('x', null, 0), topic('a', 'w1', 1), topic('y', 'gone', 2)], [unit('w1', 0)])
  assert.deepEqual(groups.map((g) => [g.unit?.id ?? null, g.topics.map((t) => t.id)]), [
    ['w1', ['a']],
    [null, ['x', 'y']],
  ])
})

test('canonical order follows units, then loose topics, whatever the stored order says', () => {
  const units = [unit('w1', 0), unit('w2', 1)]
  const topics = [topic('loose', null, 0), topic('c', 'w2', 1), topic('a', 'w1', 2), topic('b', 'w1', 3)]
  assert.deepEqual(canonicalTopicOrder(topics, units), ['a', 'b', 'c', 'loose'])
  assert.deepEqual(canonicalTopicOrder(topics, []), ['loose', 'c', 'a', 'b'])
})

test('unit mastery counts topics that are not started as zero', () => {
  assert.ok(Math.abs((unitMastery([0.8, null, undefined, 0.4]) ?? 0) - 0.3) < 1e-9)
  assert.equal(unitMastery([]), null)
  // No topic of the unit has a signal: it has no mastery to show ("Not started"), not 0% ("Learning").
  assert.equal(unitMastery([null, undefined]), null)
  assert.equal(unitMastery([0, null]), 0)
})

test('prerequisites keep only other topics of the course, once each', () => {
  const ids = new Set(['a', 'b', 'c'])
  assert.deepEqual(cleanPrerequisites('c', ['a', 'a', 'c', 'zzz', 'b'], ids), ['a', 'b'])
  assert.deepEqual(cleanPrerequisites('c', [], ids), [])
})

test('a prerequisite cycle is found by following the links', () => {
  const graph = new Map<string, string[]>([
    ['c', ['b']],
    ['b', ['a']],
    ['a', []],
  ])
  assert.equal(reachesPrerequisite(graph, 'c', 'a'), true)
  assert.equal(reachesPrerequisite(graph, 'a', 'c'), false)
  const loop = new Map<string, string[]>([['a', ['b']], ['b', ['a']]])
  assert.equal(reachesPrerequisite(loop, 'a', 'a'), true)
  assert.equal(reachesPrerequisite(loop, 'a', 'zzz'), false)
})
