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

test('the fixture reaches every action: a probe of each kind, an explanation, the new example and both closings', () => {
  const steps = (JSON.parse(fs.readFileSync(TEACH_STATE_FIXTURE, 'utf8')) as { steps: { output: Record<string, any> }[] }[]).flatMap((scenario) => scenario.steps)
  const actions = new Set(steps.map((step) => step.output.action))
  for (const action of ['probe', 'explain', 'explain_first', 'ask_new_example', 'wrap_up']) assert.ok(actions.has(action), action)
  const probes = new Set(steps.filter((step) => step.output.action === 'probe').map((step) => step.output.probe.type))
  for (const type of ['implication', 'assumption', 'confront', 'evidence', 'clarification', 'source']) assert.ok(probes.has(type), type)
  const outcomes = new Set(steps.map((step) => step.output.outcome).filter(Boolean))
  assert.deepEqual([...outcomes].sort(), ['explained', 'taught'])
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
