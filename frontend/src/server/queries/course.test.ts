import test from 'node:test'
import assert from 'node:assert/strict'
import { courseMastery } from '@/lib/mastery'
import { summarizeTopics } from './course'

const topic = (id: string, mastery: number | null, confirmed = true) => ({
  id,
  name: id,
  description: null,
  orderIndex: 0,
  unitId: null,
  confirmed,
  mastery,
  earnedMastery: mastery,
  dueAt: null,
  lastReviewedAt: null,
  progress: { notes: false, examples: false, quiz: false, quizScore: null },
  content: [],
  hasConcepts: true,
})

test('the overview summary averages over every confirmed topic', () => {
  const summary = summarizeTopics([
    topic('a', 0.61),
    ...['b', 'c', 'd', 'e', 'f', 'g'].map((id) => topic(id, null)),
    topic('draft', 1, false),
  ])
  assert.equal(summary.topicCount, 7)
  assert.equal(summary.counts.none, 6)
  assert.equal(summary.counts.getting, 1)
  assert.ok(Math.abs((summary.averageMastery ?? 0) - 0.61 / 7) < 1e-9)
  assert.equal(summarizeTopics([]).averageMastery, null)
})
