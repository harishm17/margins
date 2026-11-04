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

test('the instruction, easier-step and solid-for-now kinds word a learn item too', () => {
  const instruct = { kind: 'instruct' as const, reason: 'You missed Hash tables last time. Read p. 14 again before trying again.', href: '/courses/c1/topics/t1?view=read&focus=k1#chunk-c' }
  const out = overlayActivity(step(), instruct)
  assert.equal(out.reason, instruct.reason)
  assert.equal(out.action?.verb, 'Read about it')
  assert.equal(out.action?.href, instruct.href)
  const done = { kind: 'done_for_now' as const, reason: 'Solid for now. It comes back for review on Nov 13.', href: '/courses/c1/topics/t1?view=quiz&difficulty=hard' }
  assert.equal(overlayActivity(step(), done).action?.verb, 'Try a harder set')
  assert.equal(overlayActivity(step(), { ...done, kind: 'examples' }).action?.verb, 'See an example')
})

test('a first-quiz item is a topic item too', () => {
  assert.equal(wantsTopicActivity(step({}, { itemKind: 'quiz' })), 't1')
})

test('reviews, exams and finished days keep the plan wording', () => {
  assert.equal(wantsTopicActivity(step({}, { itemKind: 'review' })), null)
  assert.equal(wantsTopicActivity(step({}, { itemKind: 'unit_mock', topicId: null })), null)
  assert.equal(wantsTopicActivity(step({ kind: 'reviews_due' })), null)
  assert.equal(wantsTopicActivity(step({ kind: 'clear', action: null })), null)
  assert.equal(overlayActivity(step({ kind: 'clear', action: null }), activity).reason, step().reason)
})
