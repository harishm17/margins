import assert from 'node:assert/strict'
import test from 'node:test'
import { outcomeLabel } from './outcome-words'

// Spec 18.3: "I don't know" is a fine answer, so it never reads as a mistake, even when the grade also says wrong.
test('"I don\'t know" wins over every grade and never reads as a mistake', () => {
  for (const graded of [{}, { correct: true }, { partly: true }]) {
    assert.equal(outcomeLabel({ ...graded, idk: true }), "Here's what to learn")
    assert.equal(outcomeLabel({ ...graded, idk: true }, 'short'), 'To learn')
  }
  assert.equal(outcomeLabel({ correct: true }), 'Correct')
  assert.equal(outcomeLabel({ partly: true }), 'Partly')
  assert.equal(outcomeLabel({}), 'Not quite')
})
