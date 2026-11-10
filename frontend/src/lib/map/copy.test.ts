import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frontierTexts, stateLine } from './copy'
import { mapHref, NO_UNIT, parseView } from './params'

const NOW = new Date('2026-11-10T20:00:00Z')

test('the state reads as words with when it is next due', () => {
  assert.equal(stateLine('solid', '2026-11-16T20:00:00Z', NOW, 'UTC'), 'Solid · next review in 6 days')
  assert.equal(stateLine('getting_there', '2026-11-11T08:00:00Z', NOW, 'UTC'), 'Getting there · next review tomorrow')
  assert.equal(stateLine('fading', '2026-11-09T08:00:00Z', NOW, 'UTC'), 'Fading · review due')
  assert.equal(stateLine('not_started', null, NOW, 'UTC'), 'Not started')
})

test('the day count is the student\'s calendar days', () => {
  // 20:00 UTC on the 10th is the 10th in Los Angeles, and 04:00 UTC on the 11th is still the 10th there.
  assert.equal(stateLine('solid', '2026-11-11T04:00:00Z', NOW, 'America/Los_Angeles'), 'Solid · review due')
  assert.equal(stateLine('solid', '2026-11-11T04:00:00Z', NOW, 'UTC'), 'Solid · next review tomorrow')
})

test('map addresses carry the unit, topic, node and view', () => {
  assert.equal(mapHref('c1'), '/courses/c1/map')
  assert.equal(mapHref('c1', { unitId: 'u1', topicId: 't1' }), '/courses/c1/map?unit=u1&topic=t1')
  assert.equal(mapHref('c1', { unitId: null, nodeId: 'n1', view: 'list' }), `/courses/c1/map?unit=${NO_UNIT}&node=n1&view=list`)
  assert.equal(mapHref('c1', { unitId: 'u1', view: 'map' }), '/courses/c1/map?unit=u1&view=map')
  assert.equal(parseView('list'), 'list')
  assert.equal(parseView('nonsense'), 'map')
  assert.equal(parseView(undefined), 'map')
})

test('with several ideas next up, the first in list order says where to start and the rest stay next up', () => {
  const nodes = [
    { id: 'a', frontier: false },
    { id: 'b', frontier: true },
    { id: 'c', frontier: true },
    { id: 'd', frontier: true },
  ]
  assert.deepEqual(frontierTexts(nodes), { b: 'Start here', c: 'Next up', d: 'Next up' })
  // One idea next up is just next up, and none says nothing.
  assert.deepEqual(frontierTexts([{ id: 'a', frontier: true }, { id: 'b', frontier: false }]), { a: 'Next up' })
  assert.deepEqual(frontierTexts([{ id: 'a', frontier: false }]), {})
})
