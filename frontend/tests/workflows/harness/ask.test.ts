import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markerProblems } from './ask'

describe('source markers (finding 8)', () => {
  it('passes markers after the words they support', () => {
    const places = [
      { marker: '1', before: 'A relation is a set of ordered pairs.' },
      { marker: '2', before: 'It holds for every pair 1' },
    ]
    assert.deepEqual(markerProblems(places), [])
  })

  it('finds a marker after an article, a preposition or a joining word', () => {
    const places = [
      { marker: '1', before: 'This is a ' },
      { marker: '2', before: 'The proof is in the' },
      { marker: '3', before: 'Each step keeps the order and' },
    ]
    assert.deepEqual(markerProblems(places), [
      'marker 1 after "This is a"',
      'marker 2 after "The proof is in the"',
      'marker 3 after "Each step keeps the order and"',
    ])
  })

  it('finds a marker at the start of its block', () => {
    assert.deepEqual(markerProblems([{ marker: '4', before: ' \n ' }]), ['marker 4 at the start of its block'])
  })

  it('quotes at most the last 40 characters before a misplaced marker', () => {
    const before = 'This sentence runs on for quite a while before it reaches the'
    assert.deepEqual(markerProblems([{ marker: '1', before }]), [`marker 1 after "${before.slice(-40)}"`])
  })
})
