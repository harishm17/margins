import assert from 'node:assert/strict'
import test from 'node:test'
import { examShortfallNotes } from './exam-shortfall'

test('an exam as asked for has nothing to say', () => {
  assert.deepEqual(examShortfallNotes({ total_questions: 5, skipped_topics: [] }, 5), [])
  assert.deepEqual(examShortfallNotes(null, 5), [])
})

test('fewer questions than asked is said with both numbers', () => {
  assert.deepEqual(examShortfallNotes({ total_questions: 4 }, 5), ['Your exam has 4 of the 5 questions you asked for.'])
})

test('a resumed job, whose request is not known, is not compared', () => {
  assert.deepEqual(examShortfallNotes({ total_questions: 4 }, null), [])
})

test('topics left out are named, one or many', () => {
  assert.deepEqual(examShortfallNotes({ total_questions: 5, skipped_topics: ['Discrete random variables'] }, 5), [
    'Left out of the exam: Discrete random variables. There are no pages to write questions from for it.',
  ])
  assert.equal(examShortfallNotes({ total_questions: 5, skipped_topics: ['A', 'B'] }, 5)[0], 'Left out of the exam: A, B. There are no pages to write questions from for them.')
})
