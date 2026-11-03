import assert from 'node:assert/strict'
import test from 'node:test'
import { expandToConceptEvents } from './item-key'
import { instructionInput, needsInstruction } from './instruction'

const at = (iso: string) => new Date(iso)

test('needsInstruction: a fail with no instruction since', () => {
  assert.equal(needsInstruction({ lastFailAt: null, lastInstructionAt: null }), false)
  assert.equal(needsInstruction({ lastFailAt: null, lastInstructionAt: at('2026-11-10T10:00:00Z') }), false)
  assert.equal(needsInstruction({ lastFailAt: at('2026-11-10T10:00:00Z'), lastInstructionAt: null }), true)
  assert.equal(needsInstruction({ lastFailAt: at('2026-11-10T10:00:00Z'), lastInstructionAt: at('2026-11-10T09:00:00Z') }), true)
  assert.equal(needsInstruction({ lastFailAt: at('2026-11-10T10:00:00Z'), lastInstructionAt: at('2026-11-10T11:00:00Z') }), false)
  // An instruction at the very instant of the fail counts as since: the loop asks only that instruction is not older.
  assert.equal(needsInstruction({ lastFailAt: at('2026-11-10T10:00:00Z'), lastInstructionAt: at('2026-11-10T10:00:00Z') }), false)
})

test('instructionInput is a level-3 weight-0 rule event keyed by kind and ref', () => {
  const input = instructionInput('pointer', {
    userId: 'u',
    projectId: 'p',
    topicId: 't',
    conceptIds: ['c1', 'c2'],
    ref: 'c1',
    at: at('2026-11-10T20:30:00Z'),
    timeZone: 'America/Chicago',
  })
  assert.equal(input.source, 'instruction')
  assert.equal(input.assistance, 3)
  assert.equal(input.score, 0)
  assert.equal(input.gradedBy, 'rule')
  assert.equal(input.itemKey, 'instruction:pointer:c1')
  assert.deepEqual(input.metadata, { kind: 'pointer' })
  assert.deepEqual(input.conceptIds, ['c1', 'c2'])
  // One session key per kind, ref and local day, so a repeat the same day is the same event.
  assert.equal(input.sessionKey, 'instruction:pointer:c1:2026-11-10')
  const nextDay = instructionInput('pointer', { userId: 'u', projectId: 'p', topicId: 't', conceptIds: ['c1'], ref: 'c1', at: at('2026-11-11T20:30:00Z'), timeZone: 'America/Chicago' })
  assert.equal(nextDay.sessionKey, 'instruction:pointer:c1:2026-11-11')
  // The local day, not the UTC day: 02:00 UTC on the 11th is still the 10th in Chicago.
  const lateNight = instructionInput('reveal', { userId: 'u', projectId: 'p', topicId: 't', conceptIds: ['c1'], ref: 'x', at: at('2026-11-11T02:00:00Z'), timeZone: 'America/Chicago' })
  assert.equal(lateNight.sessionKey, 'instruction:reveal:x:2026-11-10')
})

test('instruction events have weight 0 and no primary/secondary split', () => {
  const input = instructionInput('gap_explainer', { userId: 'u', projectId: 'p', topicId: 't', conceptIds: ['c1', 'c2', 'c3'], ref: 'attempt-1', at: at('2026-11-10T20:30:00Z') })
  const events = expandToConceptEvents(input)
  assert.equal(events.length, 3)
  assert.ok(events.every((e) => e.weight === 0 && e.role === 'primary' && e.source === 'instruction' && e.assistance === 3 && e.score === 0))
  // Even a failure-shaped score does not give any concept a weight.
  assert.ok(expandToConceptEvents({ ...input, score: 0, blamedConceptId: 'c2' }).every((e) => e.weight === 0))
})
