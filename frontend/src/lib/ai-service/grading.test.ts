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

test('only the AI being unavailable is a wait; a refused request is an error, not queued', async () => {
  const outcome = async (status: number, body: unknown) => {
    let caught: unknown
    await withFetch(async () => json(status, body), async () => {
      await gradeAnswers([{}], {}).catch((error: unknown) => {
        caught = error
      })
    })
    return caught
  }
  assert.ok((await outcome(502, { error_code: 'LLM_CREDIT_EXHAUSTED' })) instanceof GradingUnavailableError)
  assert.ok((await outcome(503, { error_code: 'LLM_UNAVAILABLE' })) instanceof GradingUnavailableError)
  // No code: a gateway, or the service restarting.
  assert.ok((await outcome(503, {})) instanceof GradingUnavailableError)
  // The grader refused the request (a question it cannot read), or broke, or the token is wrong.
  const refused = await outcome(422, { detail: 'bad question' })
  assert.ok(refused instanceof GradingRejectedError && refused.status === 422)
  assert.ok((await outcome(500, {})) instanceof GradingRejectedError)
  assert.ok((await outcome(401, {})) instanceof GradingRejectedError)
})
