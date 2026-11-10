import assert from 'node:assert/strict'
import test from 'node:test'
import { dontKnowEvidence, isDontKnow } from './dont-know'
import type { ItemAnswerInput } from './evidence-types'

test('isDontKnow: admissions and requests are true', () => {
  for (const text of ['idk', 'IDK', 'I don\'t know', 'i dont know.', 'I don’t remember', 'i dont remember', 'no clue lol', 'no clue', 'just tell me please', 'not sure at all', 'No idea', 'no idea!!', '', '   ', '?', 'give me the answer', 'I really don\'t know, sorry']) {
    assert.equal(isDontKnow(text), true, text)
  }
})

test('isDontKnow: an attempt is false', () => {
  for (const text of ['I think it\'s the mean', 'no, the variance', 'the answer is 42', 'I don\'t know but maybe the median', 'not sure, perhaps a hash map']) {
    assert.equal(isDontKnow(text), false, text)
  }
})

const base: Omit<ItemAnswerInput, 'source' | 'score' | 'assistance' | 'gradedBy' | 'metadata'> = {
  userId: 'u',
  projectId: 'p',
  topicId: 't',
  itemKey: 'quiz:s:0',
  conceptIds: ['c1', 'c2'],
  sessionKey: 'k',
}

test('dontKnowEvidence is a wrong answer with no confidence and a cue miss', () => {
  for (const level of [0, 1, 2] as const) {
    const [input, ...rest] = dontKnowEvidence({ ...base, surface: 'quiz', level })
    assert.equal(rest.length, 0)
    assert.equal(input.score, 0)
    assert.equal(input.assistance, level)
    assert.equal(input.confidence, undefined)
    assert.equal(input.source, 'quiz')
    assert.deepEqual(input.conceptIds, ['c1', 'c2'])
    assert.deepEqual(input.metadata, { idk: true, missKind: 'cue_miss' })
    assert.equal(input.gradedBy, 'rule')
  }
})

test('dontKnowEvidence keeps the metadata of the surface and never sets a misconception', () => {
  const [input] = dontKnowEvidence({ ...base, surface: 'review', level: 0, metadata: { mode: 'recall', misconception: 'x' } })
  assert.equal(input.metadata?.mode, 'recall')
  assert.equal(input.metadata?.idk, true)
  assert.equal(input.metadata?.missKind, 'cue_miss')
  assert.equal('misconception' in (input.metadata ?? {}), false)
  assert.equal(input.source, 'review')
})

test('a lone option letter, filler word or "no" is an answer, not an admission', () => {
  for (const answer of ['A', 'a', 'B', 'I', 'it', 'is', 'no', 'No.', 'what', 'the answer']) assert.equal(isDontKnow(answer), false, answer)
  for (const admission of ['no idea', 'idk', "I don't know", 'no clue', 'just tell me', 'help', "I'm stuck", 'I dont remember', '', '???']) {
    assert.equal(isDontKnow(admission), true, admission)
  }
})
