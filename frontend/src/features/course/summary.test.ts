import test from 'node:test'
import assert from 'node:assert/strict'
import { courseSummary, fileProblem, needsWorkOrder, problemMessage, reviewTiming, studyPath, topicRowLabel } from './summary'

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

test('the study path shows missing, ready and done blocks', () => {
  const path = studyPath({
    content: ['section_notes', 'interactive_examples', 'topic_quiz'],
    progress: { notes: true, examples: false, quiz: false, quizScore: 70 },
  })
  assert.deepEqual(path, { notes: 'done', examples: 'missing', practice: 'ready', quiz: 'ready', quizScore: 70 })
})

test('practice shows as done once most of its steps are solved on the server', () => {
  const base = { content: ['interactive_examples'], progress: { notes: false, examples: false, quiz: false, quizScore: null } }
  assert.equal(studyPath(base).practice, 'ready')
  assert.equal(studyPath({ ...base, practiceDone: false }).practice, 'ready')
  assert.equal(studyPath({ ...base, practiceDone: true }).practice, 'done')
  assert.equal(studyPath({ content: [], progress: base.progress, practiceDone: false }).practice, 'missing')
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

test('a topic row is named once: topic, mastery, the next step and when it is due', () => {
  const path = { notes: 'ready', examples: 'missing', practice: 'missing', quiz: 'missing' } as const
  assert.equal(topicRowLabel({ name: 'Conditional probability', mastery: null, timing: null, path }), 'Conditional probability, Not started, next: Notes')
  assert.equal(
    topicRowLabel({ name: 'Bayes', mastery: 0.62, timing: { text: 'Due today' }, path: { ...path, notes: 'done' } }),
    'Bayes, Getting there, 62%, next: Worked examples, Due today'
  )
  assert.equal(
    topicRowLabel({ name: 'Bayes', mastery: 0.9, timing: null, path: { notes: 'done', examples: 'done', practice: 'done', quiz: 'done' } }),
    'Bayes, Strong, 90%, study path done'
  )
})
