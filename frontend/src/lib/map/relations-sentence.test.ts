import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relationsOf, relationsSentence } from './relations'

const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }))
const edge = (sourceId: string, targetId: string, type: 'prerequisite' | 'encompasses' | 'confusable', status: 'proposed' | 'confirmed' = 'confirmed') => ({ sourceId, targetId, type, status })

test('the sentence for a screen reader names every relation', () => {
  const edges = [edge('a', 'c', 'prerequisite'), edge('c', 'd', 'prerequisite', 'proposed'), edge('c', 'b', 'confusable')]
  assert.equal(relationsSentence(relationsOf('c', nodes, edges)), 'Needs A. Needed by D (suggested). Easy to mix up with B.')
  assert.equal(relationsSentence(relationsOf('d', nodes, [])), '')
})
