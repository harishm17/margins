import test from 'node:test'
import assert from 'node:assert/strict'
import { STORED_FAILURE_TEXT, retryPlan, toChatMessages, withoutRepeatedFailure, type ChatMessage } from './chat-messages'

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

const user = (id: string, text: string): ChatMessage => ({ kind: 'user', id, text })
const answer = (id: string): ChatMessage => ({
  kind: 'assistant', id, text: 'ok', marks: [], sources: [], noSources: false, notSaved: false, stopped: false, turn: null,
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

test('asking the same question again after it failed replaces the failed try', () => {
  const messages = [user('u0', 'A?'), answer('a0'), user('u1', 'B?'), failure('f1', 'B?')]
  assert.deepEqual(withoutRepeatedFailure(messages, 'B?'), [user('u0', 'A?'), answer('a0')])
})
