import assert from 'node:assert/strict'
import test from 'node:test'
import { outcomeLabel, outcomeTone, type Outcome } from './outcome-words'

test('the same result reads the same everywhere', () => {
  const table: Array<[Outcome, string, string, string]> = [
    [{ correct: true }, 'Correct', 'Right', 'accent'],
    [{ partly: true }, 'Partly', 'Partly', 'warning'],
    [{}, 'Not quite', 'Not quite', 'danger'],
    [{ idk: true }, "Here's what to learn", 'To learn', 'neutral'],
    // An "I don't know" wins over everything else, and is never red.
    [{ idk: true, correct: false, partly: false }, "Here's what to learn", 'To learn', 'neutral'],
  ]
  for (const [outcome, full, short, tone] of table) {
    assert.equal(outcomeLabel(outcome), full, JSON.stringify(outcome))
    assert.equal(outcomeLabel(outcome, 'short'), short, JSON.stringify(outcome))
    assert.equal(outcomeTone(outcome), tone, JSON.stringify(outcome))
  }
})
