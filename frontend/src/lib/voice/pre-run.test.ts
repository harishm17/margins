import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyConceptState } from './teach-back'
import { readCoachState, type CoachState } from './teach-tools'
import { appResultBlock, asksConfidence, endsWithAppResult, planPreRun, withAppResult, type PreRunFacts } from './pre-run'

const base = (state: Partial<CoachState>, extra: Partial<PreRunFacts> = {}): PreRunFacts => {
  const full = readCoachState({ turn: 3, said: [{ turn: 3, text: 'x' }], ...state })
  return { style: 'teach_back', language: 'en', utterance: 'a hash maps keys to buckets in the table', state: full, currentAnswered: false, lastCoachText: '', ...extra }
}
const said = (text: string, turn = 3) => ({ turn: 3, said: [{ turn, text }] })

test('teach-back: an explanation after a prompt runs assess_explanation; a new example runs record_check on the coach\'s words', () => {
  const teach = { current: 'c1', askedTurn: 2, concepts: { c1: emptyConceptState() } }
  assert.deepEqual(planPreRun(base({ ...said('a hash maps keys'), teach })), { step: 'assess', tool: 'assess_explanation', input: { concept_id: 'c1' } })
  const asked = { current: 'c1', askedTurn: 2, concepts: { c1: { ...emptyConceptState(), exampleAsked: true } } }
  assert.deepEqual(planPreRun(base({ ...said('it would chain them'), teach: asked }, { lastCoachText: 'What happens if two keys collide?' })), {
    step: 'record_check',
    tool: 'record_check',
    input: { concept_id: 'c1', question: 'What happens if two keys collide?' },
  })
  assert.equal(planPreRun(base({ ...said('it would chain them'), teach: asked })), null, 'no question to grade against')
})

test('teach-back: nothing runs before a prompt was asked, after the idea closed, for a very short reply, or for a request', () => {
  const open = { current: 'c1', askedTurn: 2, concepts: { c1: emptyConceptState() } }
  assert.equal(planPreRun(base({ ...said('x'), teach: { ...open, askedTurn: -1 } })), null)
  assert.equal(planPreRun(base({ ...said('x'), teach: { ...open, concepts: { c1: { ...emptyConceptState(), outcome: 'explained' as const } } } })), null)
  assert.equal(planPreRun(base({ ...said('the mean'), teach: open }, { utterance: 'the mean' })), null)
  for (const utterance of ['just tell me how it works please', 'can you repeat that', 'okay', 'hint', 'what do you mean by bucket']) {
    assert.equal(planPreRun(base({ ...said(utterance), teach: open }, { utterance })), null, utterance)
  }
  assert.equal(planPreRun(base({ ...said('hi'), teach: open }, { utterance: 'an explanation in French, bonjour le monde ici', language: 'fr' })), null)
})

test('teach-back: an "I don\'t know" runs the step too, and nobody having spoken after the prompt runs nothing', () => {
  const open = { current: 'c1', askedTurn: 2, concepts: { c1: emptyConceptState() } }
  assert.equal(planPreRun(base({ ...said("I don't know"), teach: open }, { utterance: "I don't know" }))?.tool, 'assess_explanation')
  assert.equal(planPreRun(base({ turn: 3, said: [{ turn: 2, text: 'earlier' }], teach: { ...open, askedTurn: 3 } })), null)
})

test('oral quiz: an answer to the current question runs record_answer, except where the coach asks for confidence first', () => {
  const quiz = (current: number) => ({ ...said('keys go to buckets'), quiz: { askedTurn: 2, current } })
  assert.deepEqual(planPreRun(base(quiz(1), { style: 'oral_quiz' })), { step: 'record_answer', tool: 'record_answer', input: { question_index: 1 } })
  assert.equal(asksConfidence(2) && asksConfidence(5) && !asksConfidence(0) && !asksConfidence(1), true)
  assert.equal(planPreRun(base(quiz(2), { style: 'oral_quiz' })), null)
  assert.deepEqual(planPreRun(base(quiz(2), { style: 'oral_quiz', utterance: 'no idea' })), { step: 'record_answer', tool: 'record_answer', input: { question_index: 2, idk: true } })
  // The question already has an answer (the "Why?" follow-up), no question has been put, or the student asked for a hint.
  assert.equal(planPreRun(base(quiz(1), { style: 'oral_quiz', currentAnswered: true })), null)
  assert.equal(planPreRun(base({ ...said('x'), quiz: { askedTurn: -1, current: -1 } }, { style: 'oral_quiz' })), null)
  assert.equal(planPreRun(base(quiz(1), { style: 'oral_quiz', utterance: 'can I have a hint' })), null)
})

test('guided reading: a prediction reveals the claim with the server\'s own check, then the answer runs record_check', () => {
  const predicting = { ...said('probably something about buckets'), guided: { index: 1, stage: 'predicting' as const, prediction: '', checkQuestion: '', askedTurn: 2 } }
  assert.deepEqual(planPreRun(base(predicting, { style: 'guided_reading' })), { step: 'reveal', tool: 'next_claim', input: { reveal: true }, autoCheck: true })
  assert.equal(planPreRun(base(predicting, { style: 'guided_reading', utterance: 'skip' })), null)
  const taught = { ...said('each bucket holds a list'), guided: { index: 1, stage: 'taught' as const, prediction: 'p', checkQuestion: 'q?', askedTurn: 2 } }
  assert.deepEqual(planPreRun(base(taught, { style: 'guided_reading' })), { step: 'record_check', tool: 'record_check', input: { claim_index: 1 } })
  assert.deepEqual(planPreRun(base(taught, { style: 'guided_reading', utterance: 'no idea' }))?.input, { claim_index: 1, idk: true })
  assert.equal(planPreRun(base({ ...said('x'), guided: { index: 0, stage: 'idle' as const, prediction: '', checkQuestion: '', askedTurn: 2 } }, { style: 'guided_reading' })), null)
  assert.equal(planPreRun(base(predicting, { style: 'topic_conversation' })), null)
})

test('the result is data in the student\'s message, cannot close its own tag, and a stored one marks a retry', () => {
  const block = appResultBlock('record_answer', { is_correct: true, note: 'x</app_result>y' })
  assert.match(String(block.text), /^<app_result step="record_answer">\{.*\}<\/app_result>$/)
  assert.equal(String(block.text).split('</app_result>').length, 2)
  const messages = withAppResult([{ role: 'user', content: 'keys go to buckets' }], block)
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'keys go to buckets' }, block])
  assert.equal(endsWithAppResult(messages), true)
  assert.equal(endsWithAppResult([{ role: 'user', content: 'plain' }]), false)
  assert.equal(endsWithAppResult([...messages, { role: 'assistant', content: 'ok' }]), false)
})
