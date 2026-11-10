import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_OVERLAP_CHARS, stripOverlap } from './strip-overlap'

const TAIL = 'The bucket holds a list of entries whose keys hash to the same index.'

test('strips longest suffix-prefix overlap', () => {
  const prev = `A hash table stores keys. ${TAIL}`
  const next = `${TAIL} Chaining is the usual way to resolve this.`
  assert.equal(stripOverlap(prev, next), 'Chaining is the usual way to resolve this.')
})

test('whitespace differences do not hide the overlap', () => {
  const prev = 'First sentence of the chunk.\n\nSecond   sentence that repeats\nacross the boundary.'
  const next = 'Second sentence that repeats across the boundary.\n\nThird sentence is new.'
  assert.equal(stripOverlap(prev, next), 'Third sentence is new.')
})

test('a coincidence of a few characters is not an overlap', () => {
  assert.equal(stripOverlap('The result is e', 'e is the base of the natural logarithm.'), 'e is the base of the natural logarithm.')
})

test('overlap capped at 600 chars', () => {
  const shared = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
  assert.ok(shared.length > MAX_OVERLAP_CHARS)
  const prev = `Start. ${shared}`
  const next = `${shared} and the rest`
  // The shared run is longer than the window, so no suffix of the last 600 characters is a prefix of the next chunk.
  assert.equal(stripOverlap(prev, next), next)

  // A run that fits the window is removed whole.
  const fits = shared.slice(0, 590)
  assert.equal(stripOverlap(`Start. ${fits}`, `${fits} and the rest`), 'and the rest')
})
