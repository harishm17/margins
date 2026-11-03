import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanTopic, PlanUnit } from '@/lib/learning/plan'
import { examTopicIds, fullMocksSince, learnedAt, mockMinutesSpent, unitsCovered, type MockExamFacts } from './plan'

const topic = (id: string, unitId: string | null): PlanTopic => ({
  id,
  name: id,
  unitId,
  orderIndex: 0,
  prerequisiteIds: [],
  estimatedMinutes: null,
  examRelevant: false,
  learned: false,
  started: false,
  quizzed: false,
  mastery: null,
  reviewDueAt: null,
  learnedToday: false,
})

const exam = (examId: string, day: string, ...topicIds: string[]): MockExamFacts => ({ examId, name: examId, day, topicIds: new Set(topicIds) })

test('the topics an exam asks about come from its questions', () => {
  assert.deepEqual(
    [...examTopicIds([{ topic_id: 'a' }, { topic_id: 'b' }, { topic_id: 'a' }, { question_text: 'no topic' }, null, { topic_id: 7 }])].sort(),
    ['a', 'b']
  )
  assert.equal(examTopicIds('nonsense').size, 0)
  assert.equal(examTopicIds(null).size, 0)
})

test('a unit is covered when one mock exam asked about all of its topics', () => {
  const units: PlanUnit[] = [
    { id: 'u1', title: 'One', weekLabel: null, orderIndex: 0 },
    { id: 'u2', title: 'Two', weekLabel: null, orderIndex: 1 },
    { id: 'empty', title: 'Empty', weekLabel: null, orderIndex: 2 },
  ]
  const topics = [topic('a', 'u1'), topic('b', 'u1'), topic('c', 'u2'), topic('d', 'u2')]
  assert.deepEqual(unitsCovered(units, topics, [exam('e1', '2026-10-20', 'a', 'b', 'c')]), ['u1'])
  // Two exams that each cover half do not cover the unit.
  assert.deepEqual(unitsCovered(units, topics, [exam('e1', '2026-10-20', 'c'), exam('e2', '2026-10-20', 'd')]), [])
  assert.deepEqual(unitsCovered(units, topics, [exam('e1', '2026-10-20', 'a', 'b', 'c', 'd')]), ['u1', 'u2'])
  assert.deepEqual(unitsCovered(units, topics, []), [])
})

test('a full mock exam covers at least 80% of the course and counts from its day on', () => {
  const exams = [
    exam('old', '2026-10-01', 'a', 'b', 'c', 'd', 'e'),
    exam('partial', '2026-10-30', 'a', 'b'),
    exam('full', '2026-10-31', 'a', 'b', 'c', 'd'),
    exam('whole', '2026-11-02', 'a', 'b', 'c', 'd', 'e'),
  ]
  assert.equal(fullMocksSince(exams, 5, '2026-10-29'), 2)
  assert.equal(fullMocksSince(exams, 5, '2026-11-01'), 1)
  assert.equal(fullMocksSince(exams, 5, '2026-11-03'), 0)
  assert.equal(fullMocksSince(exams, 0, '2026-10-01'), 0)
  // 4 of 5 is exactly 80%.
  assert.equal(fullMocksSince([exam('x', '2026-11-01', 'a', 'b', 'c', 'd')], 5, '2026-11-01'), 1)
  assert.equal(fullMocksSince([exam('x', '2026-11-01', 'a', 'b', 'c')], 5, '2026-11-01'), 0)
})

test("a mock exam done today counts the minutes it took, never more than its time limit", () => {
  const start = new Date('2026-10-21T10:00:00Z')
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000)
  assert.equal(mockMinutesSpent({ startedAt: start, submittedAt: at(42), durationMinutes: 60 }), 42)
  assert.equal(mockMinutesSpent({ startedAt: start, submittedAt: at(41.2), durationMinutes: 60 }), 42)
  // A late submission (or a clock skew) is held to the time limit.
  assert.equal(mockMinutesSpent({ startedAt: start, submittedAt: at(95), durationMinutes: 90 }), 90)
  // Attempts from before start times were stored count as the time limit.
  assert.equal(mockMinutesSpent({ startedAt: null, submittedAt: at(5), durationMinutes: 30 }), 30)
  assert.equal(mockMinutesSpent({ startedAt: at(5), submittedAt: start, durationMinutes: 30 }), 0)
})

test('learned uses recallAt and legacy notesCompleted', () => {
  const recall = new Date('2026-10-20T10:00:00Z')
  const completed = new Date('2026-10-01T10:00:00Z')
  // Recall is the learned signal; notes and examples no longer are.
  assert.equal(learnedAt({ recallAt: recall, notesCompleted: false, notesCompletedAt: completed }), recall)
  assert.equal(learnedAt({ recallAt: recall, notesCompleted: true, notesCompletedAt: completed }), recall)
  // A topic read before v3 stays learned, from the day its notes were completed (later visits do not move it).
  assert.equal(learnedAt({ recallAt: null, notesCompleted: true, notesCompletedAt: completed }), completed)
  assert.deepEqual(learnedAt({ recallAt: null, notesCompleted: true, notesCompletedAt: null }), new Date(0))
  // Examples done, notes not read, no recall: not learned.
  assert.equal(learnedAt({ recallAt: null, notesCompleted: false, notesCompletedAt: null }), null)
  assert.equal(learnedAt(undefined), null)
})

test('testedOut counts as learned', () => {
  const tested = new Date('2026-10-20T10:00:00Z')
  const base = { recallAt: null, notesCompleted: false, notesCompletedAt: null }
  assert.equal(learnedAt({ ...base, testedOutAt: tested }), tested)
  // Recall, when there is one, is the date.
  const recall = new Date('2026-10-19T10:00:00Z')
  assert.equal(learnedAt({ ...base, recallAt: recall, testedOutAt: tested }), recall)
  // Not tested out, not learned.
  assert.equal(learnedAt({ ...base, testedOutAt: null }), null)
})

test('a quick pass counts as learned once its first quiz is taken', () => {
  const quiz = new Date('2026-10-20T12:00:00Z')
  const base = { recallAt: null, notesCompleted: false, notesCompletedAt: null, triage: 'quick' as const, triageAt: new Date('2026-10-20T08:00:00Z') }
  assert.equal(learnedAt(base, { firstQuizAt: quiz }), quiz)
  // Before the quiz it is still to do; and a quiz without the quick pass changes nothing.
  assert.equal(learnedAt(base, { firstQuizAt: null }), null)
  assert.equal(learnedAt({ ...base, triage: null }, { firstQuizAt: quiz }), null)
})
