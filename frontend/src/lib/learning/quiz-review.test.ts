import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReview, groupResults, toStoredResults } from './quiz-review'
import { buildQuizEvidence } from './quiz-evidence'
import { replayConcept } from './memory'
import type { EventRow } from './evidence-types'
import type { GradedQuestion } from '@/lib/ai-service/grading'

const QUESTIONS = [
  {
    question_type: 'multiple_choice',
    question_text: 'Which structure does BFS use?',
    concept_ids: ['c1', 'c2'],
    correct_answer: 'A',
    options: [
      { id: 'A', text: 'queue' },
      { id: 'B', text: 'stack', misconception: 'BFS uses a stack', confusable_concept_id: 'c2' },
      { id: 'C', text: 'heap', misconception: 'BFS visits in random order' },
    ],
  },
  { question_type: 'true_false', question_text: 'Two', correct_answer: true },
  { question_type: 'true_false', question_text: 'Three', correct_answer: true },
  { question_type: 'true_false', question_text: 'Four', correct_answer: true },
  { question_type: 'true_false', question_text: 'Five', correct_answer: true },
]

const results = (...correct: boolean[]) =>
  Object.fromEntries(correct.map((isCorrect, i) => [String(i), { isCorrect, pointsEarned: isCorrect ? 1 : 0, pointsPossible: 1 }]))

test('sure wrong first', () => {
  // 0 sure and wrong, 1 unsure and wrong, 2 sure and right, 3 guessing and right, 4 wrong with no rating
  const review = buildReview(QUESTIONS, results(false, false, true, true, false))
  const groups = groupResults(review, {
    '0': { confidence: 0.95 },
    '1': { confidence: 0.5 },
    '2': { confidence: 0.75 },
    '3': { confidence: 0.25 },
  })
  assert.deepEqual(groups.sureWrong.map((i) => i.questionIndex), [0])
  assert.deepEqual(groups.wrong.map((i) => i.questionIndex), [1, 4])
})

test('unsure right separate from solid', () => {
  const review = buildReview(QUESTIONS, results(true, true, true, true, true))
  const groups = groupResults(review, {
    '0': { confidence: 0.25 },
    '1': { confidence: 0.5 },
    '2': { confidence: 0.95 },
    '3': 'plain string answer',
  })
  assert.deepEqual(groups.unsureRight.map((i) => i.questionIndex), [0, 1])
  assert.deepEqual(groups.solid.map((i) => i.questionIndex), [2, 3, 4])
  assert.equal(groups.sureWrong.length + groups.wrong.length, 0)
})

test('wrong pick shows the distractor\'s misconception', () => {
  const answers = { '0': 'c' }
  const [item] = buildReview(QUESTIONS, results(false), answers)
  assert.equal(item.pickedMisconception, 'BFS visits in random order')
  // Right pick, a pick without a misconception, and no answers at all name nothing.
  assert.equal(buildReview(QUESTIONS, results(true), { '0': 'A' })[0].pickedMisconception, null)
  assert.equal(buildReview(QUESTIONS, results(false), { '0': 'A' })[0].pickedMisconception, null)
  assert.equal(buildReview(QUESTIONS, results(false))[0].pickedMisconception, null)
})

const graded = (index: number): GradedQuestion => ({
  question_index: index,
  question_type: 'multiple_choice',
  points_possible: 1,
  points_earned: 0,
  is_correct: false,
  feedback: '',
  needs_review: false,
})

test('wrong pick sets concept misconception without a model call', () => {
  const base = { userId: 'u', projectId: 'p', topicId: 't', quizSetId: 's', attemptId: 'a', questions: QUESTIONS, graded: [graded(0)] }
  const at = new Date('2026-11-02T10:00:00Z')
  const replay = (answer: string) => {
    const [input] = buildQuizEvidence({ ...base, answers: { '0': { answer } }, at })
    const event: EventRow = {
      source: 'quiz',
      score: input.score,
      assistance: 0,
      confidence: input.confidence ?? null,
      weight: 1,
      sessionKey: input.sessionKey ?? 'k',
      createdAt: at,
      metadata: input.metadata ?? {},
    }
    return { input, state: replayConcept([event], { timeZone: 'UTC', now: at }) }
  }
  const plain = replay('C')
  assert.equal(plain.input.metadata?.missKind, 'misconception')
  assert.equal(plain.state.misconception, 'BFS visits in random order')
  // A mix-up with another concept is a discrimination miss and still names the wrong idea.
  const mixup = replay('B')
  assert.equal(mixup.input.metadata?.missKind, 'discrimination')
  assert.equal(mixup.state.misconception, 'BFS uses a stack')
})

test('a discrimination miss with no misconception text leaves the misconception unset', () => {
  const at = new Date('2026-11-02T10:00:00Z')
  const event: EventRow = {
    source: 'quiz',
    score: 0,
    assistance: 0,
    confidence: 0.5,
    weight: 1,
    sessionKey: 'k',
    createdAt: at,
    metadata: { questionType: 'multiple_choice', missKind: 'discrimination', confusableConceptId: 'c2' },
  }
  assert.equal(replayConcept([event], { timeZone: 'UTC', now: at }).misconception, null)
})

test('an "I don\'t know" is kept apart from a blank in the stored result and the review', () => {
  const graded = [0, 1].map((question_index) => ({
    question_index,
    question_type: 'true_false',
    points_possible: 1,
    points_earned: 0,
    is_correct: false,
    feedback: '',
    needs_review: false,
  })) as GradedQuestion[]
  const stored = toStoredResults(graded, new Set([1]))
  assert.equal(stored['0'].idk, undefined)
  assert.equal(stored['1'].idk, true)
  const review = buildReview(QUESTIONS.slice(1, 3), stored, { '0': '', '1': '' })
  assert.deepEqual(review.map((item) => item.dontKnow), [false, true])
  // Results stored before the flag existed read as blanks.
  assert.equal(buildReview(QUESTIONS.slice(1, 2), results(false))[0].dontKnow, false)
})
