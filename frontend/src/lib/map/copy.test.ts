import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventLine, frontierKeyText, frontierTexts, LABEL_ORDER, LABEL_TEXT, linkText, stateLine } from './copy'
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

test('every label has words, and the key lists each once', () => {
  assert.deepEqual([...LABEL_ORDER].sort(), Object.keys(LABEL_TEXT).sort())
  assert.equal(new Set(Object.values(LABEL_TEXT)).size, LABEL_ORDER.length)
})

test('an evidence line names the source, the score and any help', () => {
  assert.equal(eventLine({ source: 'quiz', score: 0.8, assisted: false }), 'Quiz · 80%')
  assert.equal(eventLine({ source: 'drill', score: 0.4, assisted: true }), 'Drill · 40% · with help')
  assert.equal(eventLine({ source: 'implicit', score: 1, assisted: false }), 'Credit from a related idea · 100%')
})

test('a suggested link is a question and a confirmed one a statement', () => {
  assert.equal(linkText('needs', 'Hashing', true), 'Needs Hashing?')
  assert.equal(linkText('needs', 'Hashing', false), 'Needs Hashing')
  assert.equal(linkText('needed_by', 'Tries', true), 'Tries needs this?')
  assert.equal(linkText('covers', 'Arrays', true), 'Covers Arrays?')
  assert.equal(linkText('covered_by', 'Trees', false), 'Trees covers this')
  assert.equal(linkText('confusable', 'Stacks', true), 'Easy to mix up with Stacks?')
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

test('the key says what the ring tests: prerequisites remembered at R >= 0.8, not prerequisites that are Solid', () => {
  assert.equal(frontierKeyText(1), 'Next up: what you need is well remembered')
  assert.equal(frontierKeyText(2), 'Next up: what you need is well remembered. Start here is the first of them.')
  assert.doesNotMatch(frontierKeyText(1), /solid/i)
})
