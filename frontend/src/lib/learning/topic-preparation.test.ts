import test from 'node:test'
import assert from 'node:assert/strict'
import { firstMissing, PREPARATION_ORDER } from './topic-preparation'

test('a topic starts with its concepts, goes on to the warm-up, then the notes; the first missing type counts', () => {
  for (const [have, first] of [
    [[], 'concepts'],
    [['concepts'], 'warmup'],
    [['concepts', 'warmup'], 'section_notes'],
    // Whatever else the topic has, the first missing type counts.
    [['section_notes', 'topic_quiz'], 'concepts'],
  ] as const) {
    assert.equal(firstMissing(new Set(have)), first, have.join(','))
  }
})

test('a topic with every type has nothing missing', () => {
  assert.equal(firstMissing(new Set(PREPARATION_ORDER)), null)
})
