import assert from 'node:assert/strict'
import test from 'node:test'
import { browserCard, cardConceptId, parseCard, parseRoute, parseStoredTutor, toStoredTutor, turnView } from './tutor-message'

const route = parseRoute({
  type: 'route',
  intent: 'understand',
  has_attempt: true,
  wants_answer: false,
  concepts: ['Hash tables', 'Heaps'],
  concept_ids: ['c1', 'c2'],
  broad: false,
  degraded: false,
})!

const card = parseCard({ question: ' What is a bucket? ', answer: 'A slot', explanation: 'Keys map to slots.', concept_name: 'Heaps' })!

test('the route event is read, and an unknown intent is not a route', () => {
  assert.deepEqual(route.concepts, ['Hash tables', 'Heaps'])
  assert.equal(route.hasAttempt, true)
  assert.equal(parseRoute({ intent: 'bogus' }), null)
  assert.equal(parseRoute(null), null)
})

test('the card is filed under the routed concept it names', () => {
  assert.equal(cardConceptId(card, route), 'c2')
  assert.equal(cardConceptId({ ...card, conceptName: '' }, route), null)
  assert.equal(cardConceptId({ ...card, conceptName: 'Invented' }, route), null)
  // A concept that did not resolve to an id is unattributed.
  assert.equal(cardConceptId(card, { ...route, conceptIds: ['c1'] }), null)
})

test('the stored turn round-trips, and the browser view has no answer', () => {
  const stored = toStoredTutor(route, card)
  const again = parseStoredTutor(JSON.parse(JSON.stringify(stored)))!
  assert.equal(again.check?.answer, 'A slot')
  assert.equal(again.check?.conceptId, 'c2')
  const view = turnView(again)!
  assert.deepEqual(view.check, { question: 'What is a bucket?', conceptName: 'Heaps', grade: null })
  assert.equal(JSON.stringify(view).includes('A slot'), false)
  assert.equal(JSON.stringify(browserCard(card)).includes('A slot'), false)
})

test('a broad question offers up to three concepts as places to start', () => {
  const broad = toStoredTutor({ ...route, broad: true, concepts: ['A', 'B', 'C', 'D'] }, null)
  assert.deepEqual(turnView(broad)?.entryPoints, ['A', 'B', 'C'])
  assert.deepEqual(turnView(toStoredTutor(route, null))?.entryPoints, [])
})
