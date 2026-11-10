import test from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWANCE_TEMPLATE } from '@/lib/budget/copy'
import { chatErrorMessage } from '@/lib/chat/errors'
import { describeJobFailure } from '@/lib/jobs/failure-message'
import { voiceErrorMessage } from '@/lib/voice/errors'
import { describeTurnFailure } from '@/features/voice/errors'
import { FALLBACK_MESSAGE, aiMessage, refusalStatus } from './messages'

const PROVIDER_CODES = ['LLM_CREDIT_EXHAUSTED', 'LLM_AUTH_FAILED', 'LLM_NOT_CONFIGURED']
// Words that belong to the operator, not the student.
const OPS_WORDING = /credit|api key|ANTHROPIC|account|credentials|configured|server|\$/i

test('provider problems read as AI being unavailable, with no ops wording, on every surface', () => {
  for (const code of PROVIDER_CODES) {
    const shared = aiMessage(code)
    assert.equal(shared.text, aiMessage('LLM_CREDIT_EXHAUSTED').text, code)
    assert.equal(shared.retry, false, code)
    for (const text of [
      shared.title,
      shared.text,
      describeJobFailure(code, 'generate_content'),
      chatErrorMessage(code).message,
      voiceErrorMessage(code).message,
      describeTurnFailure({ code, message: 'credit balance is too low', retryable: false }).alert.text,
    ]) {
      assert.doesNotMatch(text, OPS_WORDING, `${code}: ${text}`)
      assert.equal(text === shared.text || text === shared.title, true, `${code} reads differently: ${text}`)
    }
  }
})

test('the allowance has one text with the reset time as a token', () => {
  assert.equal(aiMessage('LLM_DAILY_BUDGET').text, ALLOWANCE_TEMPLATE)
  assert.equal(describeJobFailure('LLM_DAILY_BUDGET', 'Daily AI usage limit reached ($4.13 of $3.00)'), ALLOWANCE_TEMPLATE)
  assert.equal(chatErrorMessage('LLM_DAILY_BUDGET').message, ALLOWANCE_TEMPLATE)
  assert.equal(refusalStatus('LLM_DAILY_BUDGET'), 429)
  assert.equal(refusalStatus('LLM_CREDIT_EXHAUSTED'), 503)
})

test('unknown codes fall back by job type, then to a generic message', () => {
  assert.equal(aiMessage('SOMETHING_NEW', 'grade_exam').text, aiMessage('EXAM_GRADING_FAILED').text)
  assert.equal(aiMessage('SOMETHING_NEW', 'profile_exam').text, aiMessage('EXAM_PROFILE_FAILED').text)
  assert.equal(aiMessage('SOMETHING_NEW'), FALLBACK_MESSAGE)
  assert.equal(aiMessage(null), FALLBACK_MESSAGE)
})
