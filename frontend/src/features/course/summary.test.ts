import test from 'node:test'
import assert from 'node:assert/strict'
import { courseSummary, fileProblem, needsWorkOrder, problemMessage, reviewTiming } from './summary'

const counts = (strong: number) => ({ none: 0, learning: 0, getting: 0, strong })

test('the course summary leaves out parts that are zero', () => {
  assert.equal(courseSummary(12, counts(4), 2), '12 topics, 4 strong, 2 due for review')
  assert.equal(courseSummary(1, counts(0), 0), '1 topic')
  assert.equal(courseSummary(3, counts(0), 1), '3 topics, 1 due for review')
})

test('files are checked by extension and size', () => {
  assert.equal(fileProblem({ name: 'Notes.PDF', size: 1000 }, 25), null)
  assert.equal(fileProblem({ name: 'slides.pptx', size: 1000 }, 25), null)
  assert.equal(fileProblem({ name: 'notes.txt', size: 1000 }, 25), 'type')
  assert.equal(fileProblem({ name: 'noextension', size: 1000 }, 25), 'type')
  assert.equal(fileProblem({ name: 'a.pdf', size: 0 }, 25), 'empty')
  assert.equal(fileProblem({ name: 'a.pdf', size: 26 * 1024 * 1024 }, 25), 'size')
  assert.equal(fileProblem({ name: 'a.pdf', size: 25 * 1024 * 1024 }, 25), null)
  assert.equal(problemMessage('size', 25), 'Files can be up to 25 MB.')
})

test('review timing says due today or when the next review is', () => {
  const now = Date.parse('2026-10-20T15:00:00Z')
  assert.deepEqual(reviewTiming('2026-10-20T20:00:00Z', now), { due: true, text: 'Due today' })
  assert.deepEqual(reviewTiming('2026-10-17T15:00:00Z', now), { due: true, text: 'Overdue 3d' })
  assert.deepEqual(reviewTiming('2026-10-24T12:00:00Z', now), { due: false, text: 'Next review in 4 days' })
  assert.equal(reviewTiming(null, now), null)
})

test('"Needs work" puts due topics first, then the lowest mastery, not started included', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  const topics = [
    { id: 'a', mastery: 0.9, dueAt: null, orderIndex: 0 },
    { id: 'b', mastery: 0.5, dueAt: '2026-10-25T00:00:00Z', orderIndex: 1 },
    { id: 'c', mastery: null, dueAt: null, orderIndex: 2 },
    { id: 'd', mastery: 0.7, dueAt: '2026-10-19T00:00:00Z', orderIndex: 3 },
  ]
  assert.deepEqual(
    needsWorkOrder(topics, now).map((topic) => topic.id),
    ['d', 'c', 'b', 'a']
  )
})

