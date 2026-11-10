import test from 'node:test'
import assert from 'node:assert/strict'
import { inferStages } from './stage-inference'

const at = new Date('2026-10-01T10:00:00Z')
const base = { notesCompleted: false, readAt: null, recallAt: null, lastAccessedAt: null }

test('a topic read before v3 counts as read, and as recalled when it has history', () => {
  const legacy = { ...base, notesCompleted: true, lastAccessedAt: at }
  assert.deepEqual(inferStages(legacy, false), { readAt: at, recallAt: null })
  assert.deepEqual(inferStages(legacy, true), { readAt: at, recallAt: at })
})

test('a topic with a readAt was read in the reader: its history does not make it recalled', () => {
  const read = { ...base, notesCompleted: true, readAt: at, lastAccessedAt: new Date('2026-10-02T00:00:00Z') }
  assert.deepEqual(inferStages(read, true), { readAt: at, recallAt: null })
})
