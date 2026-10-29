import test from 'node:test'
import assert from 'node:assert/strict'
import { GradingUnavailableError, gradeAnswers } from './grading'

function withFetch(answer: () => Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => answer()) as typeof fetch
  return run().finally(() => {
    globalThis.fetch = original
  })
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('an unreachable model is reported with its reason, never as a score', () =>
  withFetch(
    async () => json(502, { detail: 'credit balance is too low', error_code: 'LLM_CREDIT_EXHAUSTED', retryable: false }),
    async () => {
      await assert.rejects(gradeAnswers([{}], { '0': 'x' }), (error: unknown) => {
        assert.ok(error instanceof GradingUnavailableError)
        assert.equal(error.code, 'LLM_CREDIT_EXHAUSTED')
        assert.equal(error.message, 'Grading is unavailable right now')
        assert.doesNotMatch(error.message, /credit/i)
        return true
      })
    }
  ))

test('an AI service that cannot be reached reads as AI unavailable', () =>
  withFetch(
    async () => {
      throw new TypeError('fetch failed')
    },
    async () => {
      await assert.rejects(gradeAnswers([{}], {}), (error: unknown) => {
        assert.ok(error instanceof GradingUnavailableError)
        assert.equal(error.code, 'AI_UNREACHABLE')
        return true
      })
    }
  ))

test('answers the model could not grade are never stored as a score', () =>
  withFetch(
    async () => json(200, { graded_questions: [], total_points: 1, earned_points: 0, overall_score: 0, needs_review: true }),
    async () => {
      await assert.rejects(gradeAnswers([{}], { '0': 'x' }), (error: unknown) => {
        assert.ok(error instanceof GradingUnavailableError)
        assert.equal(error.code, null)
        return true
      })
    }
  ))
