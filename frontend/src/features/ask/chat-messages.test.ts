import test from 'node:test'
import assert from 'node:assert/strict'
import { STORED_FAILURE_TEXT, retryPlan, toChatMessages, type ChatMessage } from './chat-messages'

test('a stored failure at the end of a conversation offers a retry of the question before it', () => {
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

test('a stored failure followed by later turns offers no retry', () => {
  // Retrying it would have to rewrite the turns after it; the student can ask again instead.
  const messages = toChatMessages([
    { id: 'u1', role: 'user', content: 'What is a heap?', citations: null },
    { id: 'e1', role: 'error', content: 'x', citations: null },
    { id: 'u2', role: 'user', content: 'What is a stack?', citations: null },
    { id: 'a2', role: 'assistant', content: 'A stack is...', citations: null },
  ])
  const failure = messages[1]
  assert.equal(failure.kind === 'failure' && failure.retryable, false)
})

test('a stored failure with no question before it has nothing to retry', () => {
  const [failure] = toChatMessages([{ id: 'e1', role: 'error', content: 'x', citations: null }])
  assert.equal(failure.kind === 'failure' && failure.retryable, false)
})

const user = (id: string, text: string): ChatMessage => ({ kind: 'user', id, text })
const answer = (id: string): ChatMessage => ({
  kind: 'assistant', id, text: 'ok', marks: [], sources: [], noSources: false, notSaved: false, stopped: false,
})
const failure = (id: string, question: string): ChatMessage => ({ kind: 'failure', id, message: 'x', retryable: true, question })

test('retrying the last failure replaces it and its question with the fresh try', () => {
  const plan = retryPlan([user('u1', 'A?'), answer('a1'), user('u2', 'B?'), failure('f2', 'B?')], 'f2')
  assert.deepEqual(plan, { question: 'B?', messages: [user('u1', 'A?'), answer('a1')] })
})

test('retrying never removes the turns after the failure', () => {
  // [question, failure, later question, answer]: the later exchange stays; the retry is added at the end.
  const before = [user('u1', 'A?'), failure('f1', 'A?'), user('u2', 'B?'), answer('a2')]
  const plan = retryPlan(before, 'f1')
  assert.deepEqual(plan, { question: 'A?', messages: before })
})

test('an unknown or question-less failure has no retry', () => {
  assert.equal(retryPlan([user('u1', 'A?')], 'nope'), null)
  assert.equal(retryPlan([{ kind: 'failure', id: 'f', message: 'x', retryable: true, question: null }], 'f'), null)
})
