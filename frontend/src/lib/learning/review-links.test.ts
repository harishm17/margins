import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewSessionHref } from './review-links'

test('a session link is today\'s review, a topic\'s review or a concept drill', () => {
  assert.equal(reviewSessionHref('c1'), '/courses/c1/review/session')
  assert.equal(reviewSessionHref('c1', { topicId: 't1' }), '/courses/c1/review/session?topic=t1')
  assert.equal(reviewSessionHref('c1', { conceptId: 'k1' }), '/courses/c1/review/session?concept=k1')
  // A concept wins when both are given, and empty values are left out.
  assert.equal(reviewSessionHref('c1', { topicId: 't1', conceptId: 'k1' }), '/courses/c1/review/session?concept=k1')
  assert.equal(reviewSessionHref('c1', { topicId: null, conceptId: null }), '/courses/c1/review/session')
})
