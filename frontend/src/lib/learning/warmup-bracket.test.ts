import assert from 'node:assert/strict'
import test from 'node:test'
import { focusChunks, nextWarmupDifficulty, offersTestOut, type WarmupResult } from './warmup-bracket'

const sure = { confidence: 0.75, confidenceLevel: 'fairly' as const }
const certain = { confidence: 0.95, confidenceLevel: 'certain' as const }

test('warm-up starts medium, goes up on confident right and down on wrong or guess', () => {
  assert.equal(nextWarmupDifficulty(null), 'medium')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, ...sure }), 'hard')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, ...certain }), 'hard')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: false, ...certain }), 'easy')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: false }), 'easy')
  // Right but a guess: the lucky answer says nothing about the level.
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, confidence: 0.5, confidenceLevel: 'guess' }), 'easy')
  assert.equal(nextWarmupDifficulty({ difficulty: 'hard', correct: false, ...sure }), 'medium')
  assert.equal(nextWarmupDifficulty({ difficulty: 'easy', correct: true, ...sure }), 'medium')
  // The ends hold.
  assert.equal(nextWarmupDifficulty({ difficulty: 'hard', correct: true, ...certain }), 'hard')
  assert.equal(nextWarmupDifficulty({ difficulty: 'easy', correct: false }), 'easy')
  // Right but unsure, or right with no confidence, stays at the same level.
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, confidence: 0.5, confidenceLevel: 'unsure' }), 'medium')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true }), 'medium')
  assert.equal(nextWarmupDifficulty({ difficulty: 'easy', correct: true, confidence: 0.5, confidenceLevel: 'unsure' }), 'easy')
  // A confidence stored without its level reads by its value.
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, confidence: 0.75 }), 'hard')
  assert.equal(nextWarmupDifficulty({ difficulty: 'medium', correct: true, confidence: 0.25 }), 'easy')
})

const claims = [
  { conceptId: 'a', chunkId: 'c1' },
  { conceptId: 'a', chunkId: 'c2' },
  { conceptId: 'b', chunkId: 'c3' },
  { conceptId: 'c', chunkId: 'c4' },
  { conceptId: 'c', chunkId: null },
]

test('missed warm-up concepts mark their passages Focus here and hide nothing', () => {
  const results: WarmupResult[] = [
    { conceptIds: ['a'], correct: false },
    { conceptIds: ['b'], correct: true, ...certain },
    { conceptIds: ['c'], correct: true, confidence: 0.5, confidenceLevel: 'guess' },
  ]
  // A missed concept and a guessed one light up their claims' passages, in claim order; the one known well does not.
  assert.deepEqual(focusChunks(results, claims), ['c1', 'c2', 'c4'])
  // Everything stays: the function only names chunks to mark, so a caller has nothing to hide.
  assert.deepEqual(focusChunks([], claims), [])
  assert.deepEqual(focusChunks([{ conceptIds: ['b'], correct: true, ...sure }], claims), [])
})

test('test all correct and confident offers test-out', () => {
  assert.equal(offersTestOut([{ conceptIds: [], correct: true, ...sure }, { conceptIds: [], correct: true, ...certain }, { conceptIds: [], correct: true, ...sure }]), true)
  // One wrong, one unsure, one with no confidence, or nothing asked: no offer.
  assert.equal(offersTestOut([{ conceptIds: [], correct: true, ...sure }, { conceptIds: [], correct: false, ...certain }]), false)
  assert.equal(offersTestOut([{ conceptIds: [], correct: true, ...sure }, { conceptIds: [], correct: true, confidence: 0.5, confidenceLevel: 'unsure' }]), false)
  assert.equal(offersTestOut([{ conceptIds: [], correct: true }]), false)
  assert.equal(offersTestOut([]), false)
  // A right answer marked Guessing does not offer the test-out.
  const right = { conceptIds: ['a'], correct: true }
  assert.equal(offersTestOut([{ ...right, ...sure }, { ...right, ...certain }]), true)
  assert.equal(offersTestOut([{ ...right, ...sure }, { ...right, confidence: 0.25, confidenceLevel: 'guess' }]), false)
})
