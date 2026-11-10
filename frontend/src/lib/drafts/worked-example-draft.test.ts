import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDraftKey, validateDraftPayload } from './draft-contract'
import { exampleSig, parseWorkedExampleDraft, savedItem, toWorkedExampleDraft, workedExampleKey } from './worked-example-draft'

const item = (title: string, extra: Record<string, unknown> = {}) => ({ sig: exampleSig(title), drafts: {}, done: {}, ...extra })

test('only examples with work are kept, and nothing is kept when none has any', () => {
  assert.equal(toWorkedExampleDraft({ 0: item('A'), 1: item('B', { drafts: { 'step-1': '  ' } }) }), null)
  const kept = toWorkedExampleDraft({ 0: item('A'), 1: item('B', { drafts: { 'step-1': 'guess' } }), 2: item('C', { done: { 'why-0': { idk: true, grade: 'missed', recorded: true } } }) })
  assert.deepEqual(Object.keys(kept?.items ?? {}), ['1', '2'])
})

test('saved work is found by position and title, and not for a changed set', () => {
  const draft = toWorkedExampleDraft({ 1: item('Graph  cycles', { drafts: { 'step-1': 'guess' } }) })
  assert.equal(savedItem(draft, 1, ' Graph cycles ')?.drafts['step-1'], 'guess')
  assert.equal(savedItem(draft, 1, 'Something else'), undefined)
  assert.equal(savedItem(draft, 0, 'Graph cycles'), undefined)
  assert.equal(savedItem(null, 0, 'x'), undefined)
})
