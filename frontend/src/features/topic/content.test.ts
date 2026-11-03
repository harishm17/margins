import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSolvedExamples } from './content'

const UPDATED = '2026-10-30T00:00:00Z'

test('a solved example carries its concept ids, and its steps the example ones unless they have their own', () => {
  const parsed = parseSolvedExamples(
    [
      {
        title: 'Alpha',
        problem_statement: 'Insert keys.',
        concept_ids: ['c1', 'c2'],
        solution_steps: [{ description: 'one' }, { description: 'two', concept_ids: ['c3'] }],
      },
    ],
    UPDATED
  )
  assert.deepEqual(parsed?.items[0].conceptIds, ['c1', 'c2'])
  assert.deepEqual(parsed?.items[0].steps.map((step) => step.conceptIds), [['c1', 'c2'], ['c3']])
})

test('an example from before concepts has no concept ids', () => {
  const parsed = parseSolvedExamples([{ title: 'Old', solution_steps: [{ description: 'one' }] }], UPDATED)
  assert.deepEqual(parsed?.items[0].conceptIds, [])
  assert.deepEqual(parsed?.items[0].steps[0].conceptIds, [])
})
