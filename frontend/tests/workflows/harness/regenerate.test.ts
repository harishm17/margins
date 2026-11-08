import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inheritedWork, missingParts } from './regenerate'

describe('what a dialog that starts AI work leaves unsaid (SW8, D1)', () => {
  it('names all three parts for a dialog that only says what changes', () => {
    assert.deepEqual(missingParts('This replaces your current notes.'), ['what is kept', 'how long', 'share of today'])
  })

  it('takes "stay" as saying what is kept', () => {
    assert.deepEqual(missingParts('This adds a new quiz set. Your earlier sets and attempts stay.'), ['how long', 'share of today'])
  })

  it('is empty for a dialog that says all of it', () => {
    const said = 'New notes replace these. Your margin notes are kept. About 2 minutes, about 4% of today’s allowance.'
    assert.deepEqual(missingParts(said), [])
  })

  it('takes a time in seconds and a share of the daily allowance', () => {
    assert.deepEqual(missingParts('Your answers are kept. About 40 seconds; 3% of your daily allowance.'), [])
  })
})

describe('work carried onto a different item after a regenerate (SW10)', () => {
  const before = { item: 'Step 1: find the smallest value', work: 'My working: start from the first value.' }

  it('is work shown again under an item that changed', () => {
    assert.equal(inheritedWork(before, { item: 'Step 1: count the pairs', work: before.work }), true)
  })

  it('is not work kept with the same item', () => {
    assert.equal(inheritedWork(before, { item: before.item, work: before.work }), false)
  })

  it('is not work cleared', () => {
    assert.equal(inheritedWork(before, { item: 'Step 1: count the pairs', work: '' }), false)
  })

  it('is not an empty box either side', () => {
    assert.equal(inheritedWork({ item: 'A', work: '' }, { item: 'B', work: '' }), false)
  })
})
