import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibration, CONFIDENCE_LEVELS, CONFIDENCE_WORDS, confidenceLevelOf, confidenceValue, QUIZ_RATING, selectedConfidenceLevel } from './calibration'

test('guess on 4 options is 0.25 and on true/false 0.5', () => {
  assert.equal(confidenceValue('guess', 4), 0.25)
  assert.equal(confidenceValue('guess', 2), 0.5)
  assert.equal(confidenceValue('guess'), 0.25)
  assert.equal(confidenceValue('certain', 4), 0.95)
})

test('not ready under 30', () => {
  const e = (n: number) => Array.from({ length: n }, () => ({ confidence: 0.5, score: 1 }))
  assert.equal(calibration(e(29)).ready, false)
  assert.equal(calibration(e(30)).ready, true)
})

test('bins accuracy', () => {
  const r = calibration([
    { confidence: 0.95, score: 1 },
    { confidence: 0.95, score: 0 },
    { confidence: 0.95, score: 1 },
    { confidence: 0.95, score: 1 },
    { confidence: 0.25, score: 0 },
    { confidence: 0.5, score: 0.5 },
  ])
  assert.deepEqual(r.bins.map((b) => b.label), ['guess', 'unsure', 'fairly', 'certain'])
  assert.equal(r.bins[3].n, 4)
  assert.equal(r.bins[3].accuracy, 0.75)
  assert.equal(r.bins[0].accuracy, 0)
  assert.equal(r.bins[1].accuracy, 0.5)
  assert.equal(r.bins[2].n, 0)
})

for (const [name, events, expected] of [
  ['perfect calibration is 0', [
    ...Array.from({ length: 5 }, () => ({ confidence: 1, score: 1 })),
    ...Array.from({ length: 5 }, () => ({ confidence: 0, score: 0 })),
  ], 0],
  ['an unsure right answer is 0.25', [{ confidence: 0.5, score: 1 }], 0.25],
  ['two gaps average their squares', [
    { confidence: 0.5, score: 1 },
    { confidence: 0.95, score: 0 },
  ], (0.25 + 0.9025) / 2],
] as const) {
  test(`brier is the mean of squared gaps: ${name}`, () => {
    assert.ok(Math.abs(calibration([...events]).brier - expected) < 1e-12)
  })
}

test('a stored value maps to the nearest level, a tie to the non-guess level', () => {
  assert.equal(confidenceLevelOf(0.25, 4), 'guess')
  assert.equal(confidenceLevelOf(0.5, 4), 'unsure')
  assert.equal(confidenceLevelOf(0.75, 4), 'fairly')
  assert.equal(confidenceLevelOf(0.95, 4), 'certain')
  // True or false: a guess and "unsure" are both 0.5; with no id kept, it reads as unsure.
  assert.equal(confidenceLevelOf(0.5, 2), 'unsure')
  assert.equal(confidenceLevelOf(0.5), 'unsure')
  assert.equal(confidenceLevelOf(0.2), 'guess')
  assert.equal(confidenceLevelOf(0.3333, 3), 'guess')
})

test('the chosen level wins over the value, and an unknown id falls back to the value', () => {
  assert.equal(selectedConfidenceLevel('guess', 0.5, 2), 'guess')
  assert.equal(selectedConfidenceLevel('unsure', 0.5, 2), 'unsure')
  assert.equal(selectedConfidenceLevel('bogus', 0.95, 2), 'certain')
  assert.equal(selectedConfidenceLevel(undefined, undefined, 2), '')
  assert.equal(selectedConfidenceLevel('certain', undefined, 2), 'certain')
})

test('a whole quiz is rated with the same four words as a question, stored on the 1 to 5 the review date reads', () => {
  assert.deepEqual(CONFIDENCE_LEVELS.map((level) => CONFIDENCE_WORDS[level.id]), ['Guessing', 'Unsure', 'Fairly sure', 'Certain'])
  assert.deepEqual(CONFIDENCE_LEVELS.map((level) => QUIZ_RATING[level.id]), [1, 2, 4, 5])
  // The route's rule: 1 and 2 bring the review back tomorrow, so Guessing and Unsure do; the others do not.
  assert.ok(QUIZ_RATING.guess <= 2 && QUIZ_RATING.unsure <= 2 && QUIZ_RATING.fairly > 2 && QUIZ_RATING.certain > 2)
})
