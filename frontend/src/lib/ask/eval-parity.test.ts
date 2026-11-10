import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { ASK_PARITY_FIXTURE, ASK_PARITY_SCENARIOS, askParityFixture, loadAskScenarios } from './eval-parity-files'

// The Ask eval (evals/tutoring) mirrors this logic in Python. The fixture is what the real logic does over the
// eval's scenarios; evals/tutoring/test_ask_state.py asserts the mirror reproduces it. When this fails, run
// `npx tsx scripts/ask-parity-fixture.ts` and then the eval's tests.
test('the Ask logic over the eval scenarios equals the committed parity fixture', () => {
  const scenarios = loadAskScenarios(ASK_PARITY_SCENARIOS)
  assert.ok(scenarios.length >= 50)
  const actual = JSON.parse(JSON.stringify(askParityFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(ASK_PARITY_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})

test('the word layer declines a question asked in pieces at its last piece, and lets a rewording and a translation through', () => {
  const scenarios = loadAskScenarios(ASK_PARITY_SCENARIOS).filter((scenario) => (scenario.id.includes('exam_guard_pieces') || scenario.id.includes('exam_guard_meaning')))
  assert.equal(scenarios.length, 6)
  const expected = JSON.parse(fs.readFileSync(ASK_PARITY_FIXTURE, 'utf8')) as { id: string; turns: { declined?: boolean }[] }[]
  for (const scenario of scenarios) {
    const turns = expected.find((item) => item.id === scenario.id)!.turns
    // The meaning layer (AI service) is not in this fixture: the rewording and the translation pass the words.
    assert.deepEqual(turns.map((turn) => turn.declined === true), scenario.id.includes('pieces') ? [false, false, true] : [false, false, false], scenario.id)
  }
})
