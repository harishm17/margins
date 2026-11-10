import assert from 'node:assert/strict'
import test from 'node:test'
import { focusChunks, knownCorrect, nextWarmupDifficulty, offersTestOut, pickWarmupItem, sureCorrect, type WarmupResult } from './warmup-bracket'

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

const bank = [
  { index: 0, difficulty: 'easy' as const },
  { index: 1, difficulty: 'easy' as const },
  { index: 2, difficulty: 'medium' as const },
  { index: 3, difficulty: 'medium' as const },
  { index: 4, difficulty: 'hard' as const },
]

test('the question served is the first unasked one of the level, else the nearest level', () => {
  assert.equal(pickWarmupItem(bank, [], 'medium'), 2)
  assert.equal(pickWarmupItem(bank, [2], 'medium'), 3)
  assert.equal(pickWarmupItem(bank, [4], 'hard'), 2)
  assert.equal(pickWarmupItem(bank, [0, 1], 'easy'), 2)
  assert.equal(pickWarmupItem(bank, [0, 1, 2, 3, 4], 'easy'), null)
  // A bank with no hard question serves medium for a hard request.
  assert.equal(pickWarmupItem(bank.slice(0, 4), [], 'hard'), 2)
})

test('the three questions follow the bracket through a bank of two easy, two medium, one hard', () => {
  const asked: number[] = []
  let previous: Parameters<typeof nextWarmupDifficulty>[0] = null
  // Confident and right each time: medium, then hard, then the hard one is gone so the next best level.
  for (let i = 0; i < 3; i++) {
    const index = pickWarmupItem(bank, asked, nextWarmupDifficulty(previous)) as number
    asked.push(index)
    previous = { difficulty: bank[index].difficulty, correct: true, ...certain }
  }
  assert.deepEqual(
    asked.map((i) => bank[i].difficulty),
    ['medium', 'hard', 'medium']
  )
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

test('a concept missed on one question and known on another is still a focus', () => {
  const results: WarmupResult[] = [
    { conceptIds: ['a'], correct: true, ...certain },
    { conceptIds: ['a', 'b'], correct: false },
  ]
  assert.deepEqual(focusChunks(results, claims), ['c1', 'c2', 'c3'])
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

test('sureCorrect is right with confidence of Fairly sure or higher; knownCorrect is right and not a guess', () => {
  const guess = { confidence: 0.25, confidenceLevel: 'guess' as const }
  const unsure = { confidence: 0.5, confidenceLevel: 'unsure' as const }
  assert.equal(sureCorrect({ conceptIds: ['a'], correct: true, ...sure }), true)
  assert.equal(sureCorrect({ conceptIds: ['a'], correct: true, ...certain }), true)
  assert.equal(sureCorrect({ conceptIds: ['a'], correct: true, ...unsure }), false)
  assert.equal(sureCorrect({ conceptIds: ['a'], correct: true, ...guess }), false)
  assert.equal(sureCorrect({ conceptIds: ['a'], correct: false, ...certain }), false)
  assert.equal(knownCorrect({ conceptIds: ['a'], correct: true, ...unsure }), true)
  assert.equal(knownCorrect({ conceptIds: ['a'], correct: true, ...guess }), false)
  assert.equal(knownCorrect({ conceptIds: ['a'], correct: false, ...certain }), false)
})
