import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSectionNotReady } from './course-nav'

test('while a course is in setup, the pages that are empty until then are not ready', () => {
  for (const key of ['plan', 'topics', 'ask', 'exams', 'review', 'map']) {
    assert.equal(isSectionNotReady(key, { ready: false }), true, key)
  }
})

test('Overview and Materials stay open during setup', () => {
  assert.equal(isSectionNotReady('overview', { ready: false }), false)
  assert.equal(isSectionNotReady('materials', { ready: false }), false)
})

test('every page is open once the topics are confirmed', () => {
  for (const key of ['overview', 'plan', 'topics', 'materials', 'ask', 'exams', 'review', 'map']) {
    assert.equal(isSectionNotReady(key, { ready: true }), false, key)
  }
})
