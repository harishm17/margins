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

test('the fixture covers every kind of turn and every move the scripts reach', () => {
  const expected = JSON.parse(fs.readFileSync(PARITY_FIXTURE, 'utf8')) as { turns: { event: string; move?: string; blocked?: boolean; correct?: boolean }[] }[]
  const turns = expected.flatMap((scenario) => scenario.turns)
  for (const event of ['check', 'hint', 'ask', 'clarify', 'show_worked', 'dont_know']) assert.ok(turns.some((t) => t.event === event), event)
  assert.ok(turns.some((t) => t.blocked))
  assert.ok(turns.some((t) => t.correct === true) && turns.some((t) => t.correct === false))
  const moves = new Set(turns.map((t) => t.move).filter(Boolean))
  for (const move of ['ladder', 'confront', 'confirm', 'clarify', 'worked_analogue', 'orient']) assert.ok(moves.has(move), move)
})
