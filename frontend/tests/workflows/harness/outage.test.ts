import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { endOutage, errorStateGaps, stageOutage } from './outage'

const BUSY = 'The AI is busy right now. Try again in a few minutes.'
const PAUSED = 'AI features are paused right now. Your files and progress are safe. Try again later.'

describe('what a surface that failed during an outage leaves out (WF11)', () => {
  it('is nothing with the shared message, a way to try again and the draft kept', () => {
    assert.deepEqual(errorStateGaps({ text: `AI is busy ${BUSY}`, retryShown: true, draftKept: true }, 'LLM_UNAVAILABLE'), [])
  })

  it('takes the paused message too: the shared status turns once the failures repeat', () => {
    assert.deepEqual(errorStateGaps({ text: PAUSED, retryShown: true, draftKept: true }, 'LLM_UNAVAILABLE'), [])
  })

  it('reads the message across line breaks', () => {
    assert.deepEqual(errorStateGaps({ text: BUSY.replace('right now. ', 'right now.\n'), retryShown: true, draftKept: true }, 'LLM_UNAVAILABLE'), [])
  })

  it('names a message of its own, a missing retry and a lost draft', () => {
    assert.deepEqual(errorStateGaps({ text: 'Something went wrong.', retryShown: false, draftKept: false }, 'LLM_UNAVAILABLE'), [
      'the shared message',
      'a way to try again',
      "the student's draft",
    ])
  })
})

describe('a staged outage', () => {
  it('writes the code to the stack\'s fault file, and an empty file ends it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-outage-'))
    const before = process.env.E2E_RUN_DIR
    process.env.E2E_RUN_DIR = dir
    try {
      stageOutage('LLM_UNAVAILABLE')
      assert.equal(readFileSync(path.join(dir, 'llm-fault'), 'utf8'), 'LLM_UNAVAILABLE')
      endOutage()
      assert.equal(readFileSync(path.join(dir, 'llm-fault'), 'utf8'), '')
    } finally {
      process.env.E2E_RUN_DIR = before
    }
  })
})
