import assert from 'node:assert/strict'
import test from 'node:test'
import { roleBadgeLabel } from './role'

test('a content file shows the category the student chose', () => {
  assert.equal(roleBadgeLabel('content', 'lecture_notes'), 'Lecture notes')
  assert.equal(roleBadgeLabel('content', 'book_chapters'), 'Book chapters')
})

test('past exam and syllabus keep their own words, whatever the category says', () => {
  assert.equal(roleBadgeLabel('exam', 'sample_exams'), 'Past exam')
  assert.equal(roleBadgeLabel('syllabus', 'syllabus'), 'Syllabus')
  assert.equal(roleBadgeLabel('exam', 'lecture_notes'), 'Past exam')
})

test('a role the validator or the student changed shows that role', () => {
  assert.equal(roleBadgeLabel('other', 'lecture_notes'), 'Other')
})

test('content with no category to name falls back to Content', () => {
  assert.equal(roleBadgeLabel('content', 'sample_exams'), 'Content')
  assert.equal(roleBadgeLabel('content', ''), 'Content')
})
