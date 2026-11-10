import assert from 'node:assert/strict'
import test from 'node:test'
import type { NextStep } from '@/lib/learning/next-step'
import { overlayActivity, wantsTopicActivity } from './step-activity'

const step = (overrides: Partial<NextStep> = {}, actionOverrides: Record<string, unknown> = {}): NextStep => ({
  kind: 'work',
  dueCount: 0,
  overdueCount: 0,
  deferredDue: 0,
  title: 'Learn Hash tables',
  reason: 'Read it, recall it, then practise.',
  action: { verb: 'Start', href: '/courses/c1/topics/t1', topicId: 't1', itemKind: 'learn', ...actionOverrides },
  etaLabel: 'About 35 min',
  partLabel: null,
  overBudgetLabel: null,
  then: [],
  doneToday: 0,
  minutesLeft: 35,
  later: null,
  exam: { label: null, short: false, shortMessage: null, notScheduledCount: 0 },
  ...overrides,
})

const activity = { kind: 'warmup' as const, reason: 'Try a few questions before reading. It shows what to look for.', href: '/courses/c1/topics/t1?view=warmup' }

test('a learn item takes the topic activity as its sentence, verb and address', () => {
  const out = overlayActivity(step(), activity)
  assert.equal(out.reason, activity.reason)
  assert.equal(out.action?.verb, 'Start warm-up')
  assert.equal(out.action?.href, activity.href)
  assert.equal(out.title, 'Learn Hash tables')
  assert.equal(out.etaLabel, 'About 35 min')
})

test('reviews, exams and finished days keep the plan wording', () => {
  assert.equal(wantsTopicActivity(step({}, { itemKind: 'review' })), null)
  assert.equal(wantsTopicActivity(step({}, { itemKind: 'unit_mock', topicId: null })), null)
  assert.equal(wantsTopicActivity(step({ kind: 'reviews_due' })), null)
  assert.equal(wantsTopicActivity(step({ kind: 'clear', action: null })), null)
  assert.equal(overlayActivity(step({ kind: 'clear', action: null }), activity).reason, step().reason)
})
