import assert from 'node:assert/strict'
import test from 'node:test'
import { Rating } from 'ts-fsrs'
import { conceptMastery } from './concept-mastery'
import type { EventRow } from './evidence-types'
import { bandInputsFromState, conceptBand, type BandInputs } from './level'
import { replayConcept } from './memory'

const at = (day: string) => new Date(`2026-11-${day}T16:00:00Z`)

const unknown: BandInputs = {
  abilityInputs: { groupScores: [], retrievability: 0 },
  prior: null,
  lastMaxRung: null,
  latestIsIdk: false,
  consecutiveFails: 0,
  latestGrade: null,
}
const withScores = (scores: number[], over: Partial<BandInputs> = {}, retrievability = 1): BandInputs => ({
  ...unknown,
  abilityInputs: { groupScores: scores.map((score, i) => ({ score, at: at(String(10 + i))})), retrievability },
  ...over,
})

test('ability thresholds with no step', () => {
  // An unknown concept is band 0.
  assert.equal(conceptBand(unknown), 0)
  // 0.39 -> 0, 0.4 -> 1, 0.74 -> 1, 0.75 -> 2 (no help data, so no step either way).
  assert.equal(conceptBand(withScores([0.39])), 0)
  assert.equal(conceptBand(withScores([0.4])), 1)
  assert.equal(conceptBand(withScores([0.74])), 1)
  assert.equal(conceptBand(withScores([0.75])), 2)
  // Retrievability multiplies: a strong score that has faded is not stretch.
  assert.equal(conceptBand(withScores([0.9], {}, 0.5)), 1)
})

test('q is the recency-weighted mean of the last five group scores, uncapped', () => {
  // Weights 0.5, 0.7, 0.85, 0.95, 1 on [0, 0, 1, 1, 1]: 2.8 / 4 = 0.7, band 1; on [0, 1, 1, 1, 1]: 3.5 / 4 = 0.875, band 2.
  assert.equal(conceptBand(withScores([0, 0, 1, 1, 1])), 1)
  assert.equal(conceptBand(withScores([0, 1, 1, 1, 1])), 2)
  // The window is five: an older failure beyond it is gone.
  assert.equal(conceptBand(withScores([0, 0, 1, 1, 1, 1, 1])), 2)
})

test('strong first session reaches band 2 despite the cap', () => {
  const events: EventRow[] = [
    { source: 'quiz', score: 1, assistance: 0, confidence: null, weight: 1, sessionKey: 'q1', createdAt: at('10'), metadata: { maxRung: 0 }, itemKey: 'quiz:a:0' },
  ]
  const now = new Date(at('10').getTime() + 60_000)
  const state = replayConcept(events, { timeZone: 'UTC', now })
  const { mastery, retrievability } = conceptMastery(state, 'concept', now)
  // The label still waits for a delayed success: one rating caps mastery at 0.5.
  assert.ok(Math.abs(mastery - 0.5) < 0.01)
  // But support is decided by ability, q_all times R now: 1.0 here.
  const inputs = bandInputsFromState(state, retrievability, null)
  assert.equal(inputs.abilityInputs.groupScores[0].score, 1)
  assert.equal(conceptBand(inputs), 2)
})

test('rung 3 steps down', () => {
  assert.equal(conceptBand(withScores([0.9], { lastMaxRung: 2 })), 2)
  assert.equal(conceptBand(withScores([0.9], { lastMaxRung: 3 })), 1)
  assert.equal(conceptBand(withScores([0.9], { lastMaxRung: 5 })), 1)
  assert.equal(conceptBand(withScores([0.5], { lastMaxRung: 4 })), 0)
})

test('no help and Good steps up', () => {
  assert.equal(conceptBand(withScores([0.5], { lastMaxRung: 0, latestGrade: Rating.Good })), 2)
  assert.equal(conceptBand(withScores([0.5], { lastMaxRung: 0, latestGrade: Rating.Easy })), 2)
  // Hard is not enough, nor is a Good that needed a locate hint.
  assert.equal(conceptBand(withScores([0.5], { lastMaxRung: 0, latestGrade: Rating.Hard })), 1)
  assert.equal(conceptBand(withScores([0.5], { lastMaxRung: 1, latestGrade: Rating.Good })), 1)
  // The step is clamped to the bands.
  assert.equal(conceptBand(withScores([0.95], { lastMaxRung: 0, latestGrade: Rating.Good })), 2)
  assert.equal(conceptBand(withScores([0.1], { latestIsIdk: true })), 0)
})
