import test from 'node:test'
import assert from 'node:assert/strict'
import { GradingRejectedError, GradingUnavailableError, gradeAnswers } from './grading'

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
