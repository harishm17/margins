import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileAnswers, type LocalAnswers } from './use-exam-autosave'

const local = (answers: Record<string, unknown>, synced: Record<string, unknown>): LocalAnswers => ({
  answers,
  syncedJson: JSON.stringify(synced),
  savedAt: 1,
})

test('a local copy built on the server copy, with a change that never arrived, wins', () => {
  const server = { '0': 'A' }
  assert.deepEqual(reconcileAnswers(local({ '0': 'A', '1': 'C' }, server), server), { '0': 'A', '1': 'C' })
})

test('a local copy equal to the server copy changes nothing', () => {
  const server = { '0': 'A' }
  assert.equal(reconcileAnswers(local({ '0': 'A' }, server), server), null)
})

test('when the server moved on after the local copy was made, the server wins', () => {
  const was = { '0': 'A' }
  const now = { '0': 'B', '1': 'D' }
  assert.equal(reconcileAnswers(local({ '0': 'A', '1': 'C' }, was), now), null)
})

test('no local copy keeps the server answers', () => {
  assert.equal(reconcileAnswers(null, { '0': 'A' }), null)
})

test('a confidence given after the last save is part of the difference', () => {
  const server = { '0': 'A' }
  const kept = { '0': { answer: 'A', confidence: 0.75 } }
  assert.deepEqual(reconcileAnswers(local(kept, server), server), kept)
})
