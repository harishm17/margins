import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { isDontKnow } from '@/lib/learning/dont-know'
import {
  TEACH_PROMPT_FIXTURE,
  TEACH_SCENARIOS,
  TEACH_STATE_FIXTURE,
  UTTERANCE_FIXTURE,
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
  assert.equal(scenarios.length, 26)
  const actual = JSON.parse(JSON.stringify(teachParityFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(TEACH_STATE_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})

test('the coach prompt and tools the eval sends equal the committed fixture', () => {
  const scenarios = loadTeachScenarios(TEACH_SCENARIOS)
  const actual = JSON.parse(JSON.stringify(teachPromptFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(TEACH_PROMPT_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})

test('a scenario turn is an "I don\'t know" exactly when the app\'s own detector hears one', () => {
  for (const scenario of loadTeachScenarios(TEACH_SCENARIOS)) {
    for (const turn of scenario.turns) assert.equal(turn.dont_know === true, isDontKnow(turn.say), `${scenario.id}: ${turn.say}`)
  }
})

test('the utterance classifier fixture the eval mirrors equals what the rules say', () => {
  const actual = JSON.parse(JSON.stringify(utteranceFixture(loadTeachScenarios(TEACH_SCENARIOS))))
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(UTTERANCE_FIXTURE, 'utf8')))
})
