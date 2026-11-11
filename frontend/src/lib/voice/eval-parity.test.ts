import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isDontKnow } from '@/lib/learning/dont-know'
import {
  ASSEMBLED_REPLY_FIXTURE,
  TEACH_PROMPT_FIXTURE,
  TEACH_SCENARIOS,
  TEACH_STATE_FIXTURE,
  TEACH_STATE_FIXTURE_V2,
  UTTERANCE_FIXTURE,
  assembledReplyFixture,
  ideasOf,
  loadTeachScenarios,
  teachParityFixture,
  teachPromptFixture,
  utteranceFixture,
} from './eval-parity-files'

// The teach-back eval (evals/tutoring) mirrors this logic in Python and sends the coach this prompt. The fixtures are what
// the real code does over the eval's scenarios; evals/tutoring/test_teach_state.py asserts the mirror reproduces them.
// When this fails, run `npx tsx scripts/teach-parity-fixture.ts` and then the eval's tests.
test('the teach-back logic over the eval scenarios equals the committed parity fixture', () => {
  const scenarios = loadTeachScenarios(TEACH_SCENARIOS)
  assert.equal(scenarios.length, 29)
  // Three of them are sessions of two ideas (the closing result of the first carries the second).
  assert.equal(scenarios.filter((scenario) => ideasOf(scenario).length === 2).length, 3)
  const actual = JSON.parse(JSON.stringify(teachParityFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(TEACH_STATE_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})

// The tool results read the voice flag themselves (the tags around data, the confront example, the example check's name),
// so the eval's v2 runs replay a fixture of their own. Regenerate with `npx tsx scripts/teach-parity-fixture.ts --v2`.
test('with the audited voice prompts on, the same replay equals the v2 parity fixture', () => {
  const before = process.env.PROMPTS_V2
  process.env.PROMPTS_V2 = 'voice'
  try {
    const actual = JSON.parse(JSON.stringify(teachParityFixture(loadTeachScenarios(TEACH_SCENARIOS))))
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(TEACH_STATE_FIXTURE_V2, 'utf8')))
    assert.notDeepEqual(actual, JSON.parse(fs.readFileSync(TEACH_STATE_FIXTURE, 'utf8')))
  } finally {
    if (before === undefined) delete process.env.PROMPTS_V2
    else process.env.PROMPTS_V2 = before
  }
})

test('the coach prompt and tools the eval sends equal the committed fixture', () => {
  const scenarios = loadTeachScenarios(TEACH_SCENARIOS)
  const actual = JSON.parse(JSON.stringify(teachPromptFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(TEACH_PROMPT_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})

test('a scenario turn is an "I don\'t know" exactly when the app\'s own detector hears one', () => {
  for (const scenario of loadTeachScenarios(TEACH_SCENARIOS)) {
    for (const turn of ideasOf(scenario).flatMap((idea) => idea.turns)) assert.equal(turn.dont_know === true, isDontKnow(turn.say), `${scenario.id}: ${turn.say}`)
  }
})

test('the utterance classifier fixture the eval mirrors equals what the rules say', () => {
  const actual = JSON.parse(JSON.stringify(utteranceFixture(loadTeachScenarios(TEACH_SCENARIOS))))
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(UTTERANCE_FIXTURE, 'utf8')))
})

// VOICE_GRADER_LED: the replies the app says without a model call. The fixture pins the wording for the eval's mirror;
// the assertions below are what a student relies on whatever the wording.
test('the replies the app builds equal the committed fixture, never give an open claim away, and ask one question', () => {
  const cases = JSON.parse(JSON.stringify(assembledReplyFixture())) as { name: string; facts: { plan: { action: string } }; reply: string | null }[]
  assert.deepEqual(cases, JSON.parse(fs.readFileSync(ASSEMBLED_REPLY_FIXTURE, 'utf8')))
  const reply = (name: string) => cases.find((entry) => entry.name === name)!.reply
  // Left to the coach model: no question from the grader that can be said (none, two in one, one that says the claim, one
  // already asked), which a wrong claim and a second probe cannot do without, and a closing turn with nothing known to follow.
  const left = [
    'a pointer that only names the idea', 'a pointer holding two questions', 'a question too long to say', 'a leading question that says the claim',
    'a question that names its answers', 'two questions joined, the first a yes or no',
    'wrong claim', 'second probe on the same gap', 'loose claim, no question, a long quote', 'a quote with a question in it',
    'a spoken question that says the claim', 'second probe, the question already asked',
    'a prerequisite named as a question', 'a claim too long to say', 'a claim worded as a question', 'the next idea is named as a question',
    'a closing turn with nothing known to follow',
  ]
  for (const name of left) assert.equal(reply(name), null, name)
  assert.equal(cases.filter((entry) => entry.reply === null).length, left.length)
  for (const entry of cases.filter((item) => item.reply !== null)) {
    const questions = entry.reply!.split('?').length - 1
    if (entry.facts.plan.action === 'probe') {
      assert.equal(entry.reply!.includes('Chaining keeps'), false, `${entry.name}: a probe says the claim`)
      assert.equal(questions, 1, entry.name)
    }
    if (entry.facts.plan.action === 'explain' || entry.facts.plan.action === 'explain_first') assert.equal(questions, 1, entry.name)
    assert.equal(/page 0\b/.test(entry.reply!), false, entry.name)
    if (entry.facts.plan.action === 'wrap_up') assert.equal(questions, 0, entry.name)
  }
  // Of two questions joined in one sentence the app asks the first, so the student has one thing to hold.
  assert.ok(reply('two questions joined in one sentence')!.endsWith('Where does a new key land at first?'))
  assert.ok(reply('wrong claim, a spoken question joining two')!.endsWith('Where does the second key go?'))
  assert.ok(reply('closed with a claim still open')!.startsWith("Let's leave that one there"), 'no praise for what was not shown')
})
