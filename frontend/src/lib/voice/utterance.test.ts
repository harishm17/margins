import assert from 'node:assert/strict'
import test from 'node:test'
import { isDontKnow } from '@/lib/learning/dont-know'
import { loadTeachScenarios, TEACH_SCENARIOS } from './eval-parity-files'
import { classifyUtterance, hasSubstance, type UtteranceKind } from './utterance'

const cases: Record<UtteranceKind, string[]> = {
  control: ['stop', 'Skip this one', 'next question', "I'm done", 'can we stop', "that's all for now", 'move on', 'okay stop please'],
  idk: ["I don't know", 'idk', 'no idea', 'no clue', "I don't remember", 'honestly no idea lol'],
  meta: [
    'repeat that',
    'say that again',
    'can you say that again please',
    'slower',
    'pardon',
    'sorry?',
    'what was the question',
    'hint',
    'can I get a hint',
    "I'm stuck",
    'just tell me',
    'what is the answer',
    'can you explain it',
    'okay',
    'let me think',
    'hold on',
    'what do you mean by bucket',
    'is it the second one?',
    'why does that matter',
    'um',
    '',
  ],
  answer: [
    'a hash function maps a key to a bucket index',
    'I think it is the load factor divided by two',
    'true',
    'the mean',
    'It halves the search space each time so it takes logarithmic time because the list is sorted',
    'how a hash table works is that it stores keys in buckets and looks them up by hash',
    'no',
    'yes',
  ],
}

for (const [kind, texts] of Object.entries(cases)) {
  test(`classifies as ${kind}`, () => {
    for (const text of texts) assert.equal(classifyUtterance(text), kind, text)
  })
}

test('an explanation that mentions next or stop is not a control', () => {
  assert.equal(classifyUtterance('the next bucket is checked when the first one is full so the search does not stop'), 'answer')
})

test('hasSubstance wants a few words for an explanation, and accepts an I do not know', () => {
  assert.equal(hasSubstance('the mean', 'answer'), false)
  assert.equal(hasSubstance('it is the mean of the values', 'answer'), true)
  assert.equal(hasSubstance("I don't know", 'idk'), true)
  assert.equal(hasSubstance('repeat that', 'meta'), false)
})

test('every scripted student turn of the teach-back eval is an answer or an I do not know, except the asks for the answer and the off-topic questions', () => {
  for (const scenario of loadTeachScenarios(TEACH_SCENARIOS)) {
    for (const turn of scenario.turns) {
      const kind = classifyUtterance(turn.say)
      const notAnAnswer = /just_tell_me|off_topic/.test(scenario.id)
      const plain = isDontKnow(turn.say) ? 'idk' : 'answer'
      assert.ok(kind === plain || (notAnAnswer && kind === 'meta'), `${scenario.id}: ${turn.say}`)
    }
  }
})
