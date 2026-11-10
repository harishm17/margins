import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { loadScenarios, parityFixture, PARITY_FIXTURE, PARITY_SCENARIOS } from './eval-parity-files'

// The tutoring eval (evals/tutoring) mirrors this logic in Python. The fixture is what the real logic
// does over the eval's scenarios; evals/tutoring/test_app_state.py asserts the mirror reproduces it.
// When this fails, run `npx tsx scripts/tutoring-parity-fixture.ts` and then the eval's tests.
test('the tutor logic over the eval scenarios equals the committed parity fixture', () => {
  const scenarios = loadScenarios(PARITY_SCENARIOS)
  assert.ok(scenarios.length >= 12)
  const actual = JSON.parse(JSON.stringify(parityFixture(scenarios)))
  const expected = JSON.parse(fs.readFileSync(PARITY_FIXTURE, 'utf8'))
  assert.deepEqual(actual, expected)
})
