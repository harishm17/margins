import assert from 'node:assert/strict'
import test from 'node:test'
import { roleBadgeLabel } from './role'

test('past exam and syllabus keep their own words; content shows the chosen category', () => {
  assert.equal(roleBadgeLabel('content', 'lecture_notes'), 'Lecture notes')
  assert.equal(roleBadgeLabel('exam', 'lecture_notes'), 'Past exam')
  assert.equal(roleBadgeLabel('content', ''), 'Content')
})
