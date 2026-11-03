import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_IDK_MARKER, normalizeAnswers, plainAnswers } from '@/lib/learning/quiz-answers'
import { parseSession } from './quiz-session'

test('a session stored before confidence existed (plain string answers) converts and submits', () => {
  const stored = JSON.stringify({ answers: { '0': 'B', '1': 'a short answer', '2': '  ' }, index: 1 })
  const session = parseSession(stored)
  assert.deepEqual(session, {
    answers: { '0': { answer: 'B' }, '1': { answer: 'a short answer' }, '2': { answer: '  ' } },
    index: 1,
  })

  // What the view sends: blank answers left out. The server reads it back to the same plain answers.
  const sent = Object.fromEntries(Object.entries(session!.answers).filter(([, value]) => value.answer.trim()))
  assert.deepEqual(plainAnswers(normalizeAnswers(sent)), { '0': 'B', '1': 'a short answer' })
})

test('a new session keeps confidence, thinking and the prediction', () => {
  const stored = JSON.stringify({
    answers: { '0': { answer: 'B', confidence: 0.75, thinking: 'queue' } },
    index: 0,
    predicted: 3,
  })
  assert.deepEqual(parseSession(stored), {
    answers: { '0': { answer: 'B', confidence: 0.75, thinking: 'queue' } },
    index: 0,
    predicted: 3,
  })
  assert.equal(parseSession('not json'), null)
})

test('an "I don\'t know" survives the draft round trip', () => {
  const session = parseSession(JSON.stringify({ answers: { '0': { answer: '', idk: true }, '1': { answer: 'B', confidence: 0.5 } }, index: 1 }))!
  assert.deepEqual(session.answers['0'], { answer: '', idk: true })
  // The draft is the session itself: no marker text, the flag stays a flag.
  assert.equal(JSON.stringify(session).includes(LEGACY_IDK_MARKER), false)
  assert.deepEqual(parseSession(JSON.stringify(session)), session)
})

test('a draft saved with the old marker text still reads as "I don\'t know"', () => {
  const session = parseSession(JSON.stringify({ answers: { '0': { answer: LEGACY_IDK_MARKER }, '1': LEGACY_IDK_MARKER }, index: 1 }))!
  assert.deepEqual(session.answers, { '0': { answer: '', idk: true }, '1': { answer: '', idk: true } })
})
