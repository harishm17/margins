import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestsByTopic } from './review-requests'
import type { MissingItems } from './review-select'

const group = (topicId: string, conceptIds: string[], mode: MissingItems['mode'] = 'recall', difficulty: MissingItems['difficulty'] = 'medium'): MissingItems => ({
  topicId,
  conceptIds,
  mode,
  difficulty,
})

test('one job per topic, each concept in its mode and difficulty', () => {
  const byTopic = requestsByTopic([group('t1', ['a', 'b']), group('t2', ['c'], 'discrimination', 'hard'), group('t1', ['d'], 'recall', 'easy')])
  assert.deepEqual([...byTopic.keys()], ['t1', 't2'])
  assert.deepEqual(byTopic.get('t1'), [
    { conceptIds: ['a', 'b'], mode: 'recall', difficulty: 'medium' },
    { conceptIds: ['d'], mode: 'recall', difficulty: 'easy' },
  ])
  // Nothing missing means no requests.
  assert.equal(requestsByTopic([]).size, 0)
  assert.equal(requestsByTopic([group('t1', [])]).size, 0)
})

test('a concept reported twice in one mode is asked for once, easy when one of the reports is the opener', () => {
  const byTopic = requestsByTopic([group('t1', ['a', 'b'], 'recall', 'medium'), group('t1', ['a'], 'recall', 'easy')])
  assert.deepEqual(byTopic.get('t1'), [
    { conceptIds: ['a'], mode: 'recall', difficulty: 'easy' },
    { conceptIds: ['b'], mode: 'recall', difficulty: 'medium' },
  ])
  // At the same level the first report is kept, and other modes stay separate requests.
  const sameLevel = requestsByTopic([group('t1', ['a'], 'recall', 'hard'), group('t1', ['a'], 'recall', 'medium'), group('t1', ['a'], 'discrimination', 'hard')])
  assert.deepEqual(sameLevel.get('t1'), [
    { conceptIds: ['a'], mode: 'recall', difficulty: 'hard' },
    { conceptIds: ['a'], mode: 'discrimination', difficulty: 'hard' },
  ])
})
