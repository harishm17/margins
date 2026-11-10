import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isDontKnow } from '@/lib/learning/dont-know'
import {
  TEACH_PROMPT_FIXTURE,
  TEACH_SCENARIOS,
  TEACH_STATE_FIXTURE,
  TEACH_STATE_FIXTURE_V2,
  UTTERANCE_FIXTURE,
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
