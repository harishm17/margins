import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relationsOf } from './relations'

const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }))
const edge = (sourceId: string, targetId: string, type: 'prerequisite' | 'encompasses' | 'confusable', status: 'proposed' | 'confirmed' = 'confirmed') => ({ sourceId, targetId, type, status })

test('prerequisites read from both ends', () => {
  const edges = [edge('a', 'c', 'prerequisite'), edge('b', 'c', 'prerequisite', 'proposed')]
  assert.deepEqual(relationsOf('c', nodes, edges), [{ label: 'Needs', names: ['A', 'B (suggested)'] }])
  assert.deepEqual(relationsOf('a', nodes, edges), [{ label: 'Needed by', names: ['C'] }])
})

test('a confusable pair reads the same from either side, and a lone concept has no relations', () => {
  const edges = [edge('a', 'b', 'confusable')]
  assert.deepEqual(relationsOf('a', nodes, edges), [{ label: 'Easy to mix up with', names: ['B'] }])
  assert.deepEqual(relationsOf('b', nodes, edges), [{ label: 'Easy to mix up with', names: ['A'] }])
  assert.deepEqual(relationsOf('d', nodes, edges), [])
})
