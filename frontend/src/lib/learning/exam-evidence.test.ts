import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExamEvidence, } from './exam-evidence'

const QUESTIONS = [
  { question_type: 'multiple_choice', topic_id: 't1', concept_ids: ['c1'], options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y', misconception: 'wrong idea' }] },
  { question_type: 'short_answer', topic_id: 't2', concept_ids: ['c1', 'c2'] },
  { question_type: 'true_false', topic_id: 'gone', concept_ids: ['c1'] },
]
const graded = (index: number, type: string, earned: number, extra: Record<string, unknown> = {}) => ({
  question_index: index,
  question_type: type,
  points_possible: 1,
  points_earned: earned,
  is_correct: earned >= 0.7,
  feedback: '',
  needs_review: false,
  ...extra,
})

test('exam evidence is level 0, source exam, filed under each question\'s topic', () => {
  const events = buildExamEvidence({
    userId: 'u',
    projectId: 'p',
    examId: 'e1',
    submissionId: 's1',
    questions: QUESTIONS,
    answers: { '0': { answer: 'B', confidence: 0.95 }, '1': 'because', '2': true },
    aiGrading: { graded_questions: [graded(0, 'multiple_choice', 0), graded(1, 'short_answer', 1, { blamed_concept_id: 'c2' }), graded(2, 'true_false', 1)] },
    knownTopicIds: new Set(['t1', 't2']),
  })
  assert.deepEqual(events.map((e) => [e.itemKey, e.source, e.sessionKey, e.topicId, e.gradedBy, e.assistance]), [
    ['exam:e1:0', 'exam', 'exam:s1', 't1', 'rule', 0],
    ['exam:e1:1', 'exam', 'exam:s1', 't2', 'model', 0],
    ['exam:e1:2', 'exam', 'exam:s1', null, 'rule', 0],
  ])
  assert.equal(events[0].confidence, 0.95)
  assert.equal(events[0].metadata?.misconception, 'wrong idea')
})

test('unanswered and ungradable questions are not evidence', () => {
  const events = buildExamEvidence({
    userId: 'u',
    projectId: 'p',
    examId: 'e1',
    submissionId: 's1',
    questions: QUESTIONS,
    answers: { '0': '', '1': 'text' },
    aiGrading: { graded_questions: [graded(0, 'multiple_choice', 0), graded(1, 'short_answer', 0, { needs_review: true })] },
  })
  assert.deepEqual(events, [])
})
