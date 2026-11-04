import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDraftPayload } from './draft-contract'
import { LEGACY_IDK_MARKER } from '@/lib/learning/quiz-answers'

const quiz = (answers: unknown) => validateDraftPayload('quiz', { answers, index: 1 })

test('a quiz draft keeps the idk flag and drops what an unanswered question cannot have', () => {
  const checked = quiz({ '0': { answer: '', idk: true, confidence: 0.5, thinking: 'x' }, '1': { answer: 'B', confidence: 0.5 } })
  assert.ok(checked.ok)
  assert.deepEqual((checked.payload as { answers: unknown }).answers, { '0': { answer: '', idk: true }, '1': { answer: 'B', confidence: 0.5 } })
})

test('a quiz draft refuses an idk that is not a boolean', () => {
  assert.equal(quiz({ '0': { answer: '', idk: 'yes' } }).ok, false)
})

test('a draft written with the old marker text is stored as an idk answer', () => {
  for (const answer of [LEGACY_IDK_MARKER, { answer: LEGACY_IDK_MARKER }]) {
    const checked = quiz({ '0': answer })
    assert.ok(checked.ok)
    assert.deepEqual((checked.payload as { answers: unknown }).answers, { '0': { answer: '', idk: true } })
  }
})

test('an Ask draft keeps the id of a send in flight, and refuses one that is not an id', () => {
  const id = '7efa1ba6-0dce-48b7-a37a-7df217dc94b8'
  const kept = validateDraftPayload('ask', { text: 'Why?', sending: id, sentAt: 1_700_000_000_000 })
  assert.ok(kept.ok)
  assert.deepEqual(kept.payload, { text: 'Why?', sending: id, sentAt: 1_700_000_000_000 })
  assert.equal(validateDraftPayload('ask', { text: 'Why?', sending: 'not an id' }).ok, false)
  assert.ok(validateDraftPayload('ask', { text: 'Why?' }).ok)
})
