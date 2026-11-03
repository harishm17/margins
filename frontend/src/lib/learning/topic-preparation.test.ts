import test from 'node:test'
import assert from 'node:assert/strict'
import { firstMissing, PREPARATION_ORDER } from './topic-preparation'

test('a topic with nothing starts with its concepts', () => {
  assert.equal(firstMissing(new Set()), 'concepts')
})

test('a topic with its concepts goes on to the warm-up, then the notes', () => {
  assert.equal(firstMissing(new Set(['concepts'])), 'warmup')
  assert.equal(firstMissing(new Set(['concepts', 'warmup'])), 'section_notes')
})

test('the first missing type counts, whatever else the topic has', () => {
  assert.equal(firstMissing(new Set(['section_notes', 'topic_quiz'])), 'concepts')
})

test('a topic with every type has nothing missing', () => {
  assert.equal(firstMissing(new Set(PREPARATION_ORDER)), null)
})
