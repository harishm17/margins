import test from 'node:test'
import assert from 'node:assert/strict'
import { STORED_FAILURE_TEXT, toChatMessages } from './chat-messages'

test('a failure stored by an older version offers a retry of the question before it', () => {
  const messages = toChatMessages([
    { id: 'u1', role: 'user', content: 'What is a heap?', citations: null },
    { id: 'e1', role: 'error', content: 'The model declined to answer that.', citations: null },
  ])
  assert.deepEqual(messages[1], {
    kind: 'failure',
    id: 'e1',
    message: STORED_FAILURE_TEXT,
    retryable: true,
    question: 'What is a heap?',
  })
})

test('a stored failure with no question before it has nothing to retry', () => {
  const [failure] = toChatMessages([{ id: 'e1', role: 'error', content: 'x', citations: null }])
  assert.equal(failure.kind === 'failure' && failure.retryable, false)
})
