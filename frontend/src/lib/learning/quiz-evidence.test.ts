import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQuizEvidence } from './quiz-evidence'
import type { GradedQuestion } from '@/lib/ai-service/grading'

const QUESTIONS = [
  {
    question_type: 'multiple_choice',
    concept_ids: ['c1', 'c2'],
    mode: 'discrimination',
    correct_answer: 'A',
    options: [
      { id: 'A', text: 'right' },
      { id: 'B', text: 'mix-up', misconception: 'BFS uses a stack', confusable_concept_id: 'c2' },
      { id: 'C', text: 'plain wrong', misconception: 'BFS is random' },
    ],
  },
  { question_type: 'short_answer', concept_ids: ['c1', 'c2'], mode: 'recall' },
  { question_type: 'true_false', concept_ids: [] },
  { question_type: 'multiple_choice', concept_ids: ['c1'], options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }] },
]

const graded = (index: number, type: string, earned: number, possible = 1, extra: Partial<GradedQuestion> = {}): GradedQuestion => ({
  question_index: index,
  question_type: type,
  points_possible: possible,
  points_earned: earned,
  is_correct: earned >= possible * 0.7,
  feedback: '',
  needs_review: false,
  ...extra,
})

const base = {
  userId: 'u',
  projectId: 'p',
  topicId: 't',
  quizSetId: 'set1',
  attemptId: 'att1',
  questions: QUESTIONS,
}

test('a wrong choice names its wrong idea through the picked option', () => {
  const [event] = buildQuizEvidence({
    ...base,
    answers: { '0': { answer: 'C', confidence: 0.95 } },
    graded: [graded(0, 'multiple_choice', 0)],
  })
  assert.equal(event.itemKey, 'quiz:set1:0')
  assert.equal(event.source, 'quiz')
  assert.equal(event.assistance, 0)
  assert.equal(event.gradedBy, 'rule')
  assert.equal(event.confidence, 0.95)
  assert.equal(event.sessionKey, 'quiz:att1')
  assert.deepEqual(event.metadata, { questionType: 'multiple_choice', mode: 'discrimination', misconception: 'BFS is random', missKind: 'misconception' })
  assert.equal(event.blamedConceptId, undefined)
})

test('a pick that mixes up another concept is a discrimination miss and blames that concept', () => {
  const [event] = buildQuizEvidence({ ...base, answers: { '0': { answer: 'b' } }, graded: [graded(0, 'multiple_choice', 0)] })
  assert.equal(event.metadata?.missKind, 'discrimination')
  assert.equal(event.blamedConceptId, 'c2')
})

test('a model-graded short answer is marked short_answer with the grader diagnosis', () => {
  const [event] = buildQuizEvidence({
    ...base,
    answers: { '1': { answer: 'something', thinking: 'hm' } },
    graded: [graded(1, 'short_answer', 1, 4, { blamed_concept_id: 'c2', misconception: 'Caches store cold data.' })],
  })
  assert.equal(event.gradedBy, 'model')
  assert.equal(event.score, 0.25)
  assert.equal(event.blamedConceptId, 'c2')
  assert.equal(event.metadata?.questionType, 'short_answer')
  assert.equal(event.metadata?.missKind, 'misconception')
  assert.equal(event.metadata?.misconception, 'Caches store cold data.')
})

test('right answers carry no miss kind, and items without concepts or answers write nothing', () => {
  const events = buildQuizEvidence({
    ...base,
    answers: { '0': { answer: 'A' }, '2': { answer: 'true' }, '3': { answer: '  ' } },
    graded: [graded(0, 'multiple_choice', 1), graded(1, 'short_answer', 0), graded(2, 'true_false', 1), graded(3, 'multiple_choice', 0)],
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].metadata?.missKind, undefined)
  assert.equal(events[0].confidence, undefined)
})

test('a legacy quiz with no set id keys items under legacy, and unknown concepts are ignored', () => {
  const events = buildQuizEvidence({
    ...base,
    quizSetId: null,
    knownConceptIds: new Set(['c1']),
    answers: { '0': { answer: 'A' } },
    graded: [graded(0, 'multiple_choice', 1)],
  })
  assert.equal(events[0].itemKey, 'quiz:legacy:0')
  assert.deepEqual(events[0].conceptIds, ['c1'])
})

test('a blamed concept that is not an active concept of the question is dropped', () => {
  const [event] = buildQuizEvidence({
    ...base,
    knownConceptIds: new Set(['c1']),
    answers: { '1': { answer: 'something' } },
    graded: [graded(1, 'short_answer', 0, 4, { blamed_concept_id: 'c2' })],
  })
  assert.deepEqual(event.conceptIds, ['c1'])
  assert.equal(event.blamedConceptId, undefined)
})

test('idk answer grades wrong with no confidence', () => {
  const [event, ...rest] = buildQuizEvidence({
    ...base,
    answers: { '0': { answer: '', idk: true, confidence: 0.95 } },
    graded: [graded(0, 'multiple_choice', 0)],
  })
  assert.equal(rest.length, 0)
  assert.equal(event.source, 'quiz')
  assert.equal(event.score, 0)
  assert.equal(event.assistance, 0)
  assert.equal(event.confidence, undefined)
  assert.equal(event.itemKey, 'quiz:set1:0')
  assert.equal(event.sessionKey, 'quiz:att1')
  assert.deepEqual(event.conceptIds, ['c1', 'c2'])
  assert.equal(event.metadata?.idk, true)
  assert.equal(event.metadata?.missKind, 'cue_miss')
  assert.equal(event.metadata?.misconception, undefined)
  assert.equal(event.metadata?.questionType, 'multiple_choice')
  assert.equal(event.metadata?.mode, 'discrimination')
})

test('same-day identical submission is level 2', () => {
  const events = buildQuizEvidence({
    ...base,
    sameDayRepeat: true,
    answers: { '0': { answer: 'A', confidence: 0.75 }, '1': { answer: '', idk: true } },
    graded: [graded(0, 'multiple_choice', 1), graded(1, 'short_answer', 0, 4)],
  })
  assert.equal(events.length, 2)
  for (const event of events) {
    assert.equal(event.assistance, 2)
    assert.equal(event.metadata?.repeat, 'same_day')
  }
})

test('a first attempt is level 0 with no repeat mark', () => {
  const [event] = buildQuizEvidence({ ...base, answers: { '0': { answer: 'A' } }, graded: [graded(0, 'multiple_choice', 1)] })
  assert.equal(event.assistance, 0)
  assert.equal(event.metadata?.repeat, undefined)
})
