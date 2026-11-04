import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { ACTIVITY_KINDS, activityHref, activityVerb, bareTopicRedirect, defaultViewFor, opensHere, pathStepFor, viewInPath } from './activity-copy'

const ctx = { courseId: 'c1', topicId: 't1', conceptIds: ['k1', 'k2'], unitTopicIds: ['t0', 't1'], target: { conceptId: 'k1', via: 'reread' as const, chunkId: 'ch1' } }

test('each kind maps to its destination', () => {
  const expected: Record<ActivityKind, string> = {
    start: '/courses/c1/topics/t1',
    instruct: '/courses/c1/topics/t1?view=read&focus=k1#chunk-ch1',
    examples: '/courses/c1/topics/t1?view=examples&focus=k1&fade=full',
    done_for_now: '/courses/c1/topics/t1?view=quiz&difficulty=hard',
    fix_misconception: '/courses/c1/review/session?concept=k1',
    prerequisite_drill: '/courses/c1/review/session?concept=k1',
    review: '/courses/c1/review/session?topic=t1',
    transfer_quiz: '/courses/c1/topics/t1?view=quiz&difficulty=hard',
    mock_exam: '/courses/c1/exams/new?topics=t0,t1',
    teach_back: '/courses/c1/topics/t1?view=recall&mode=teach_back',
    warmup: '/courses/c1/topics/t1?view=warmup',
    read: '/courses/c1/topics/t1?view=read',
    recall: '/courses/c1/topics/t1?view=recall',
    explainer: '/courses/c1/topics/t1?view=explainer',
    quiz: '/courses/c1/topics/t1?view=quiz',
    practice: '/courses/c1/topics/t1?view=practice',
  }
  assert.deepEqual([...ACTIVITY_KINDS].sort(), Object.keys(expected).sort())
  for (const kind of ACTIVITY_KINDS) assert.equal(activityHref(kind, ctx), expected[kind], kind)
})

test('every kind has a button verb', () => {
  for (const kind of ACTIVITY_KINDS) assert.ok(activityVerb(kind).length > 0, kind)
  assert.equal(activityVerb('quiz'), 'Take quiz')
  assert.equal(activityVerb('review'), 'Review')
  assert.equal(activityVerb('instruct'), 'Read about it')
  assert.equal(activityVerb('examples'), 'See an example')
  assert.equal(activityVerb('done_for_now'), 'Try a harder set')
})

test('a kind outside the topic page opens on practice; the rest on their own view', () => {
  assert.equal(defaultViewFor('warmup'), 'warmup')
  assert.equal(defaultViewFor('read'), 'read')
  assert.equal(defaultViewFor('explainer'), 'explainer')
  assert.equal(defaultViewFor('teach_back'), 'recall')
  assert.equal(defaultViewFor('transfer_quiz'), 'quiz')
  for (const kind of ['fix_misconception', 'prerequisite_drill', 'review', 'mock_exam', 'done_for_now'] as const) {
    assert.equal(defaultViewFor(kind), 'practice', kind)
  }
  // The reader and the examples are views of the topic.
  assert.equal(defaultViewFor('examples'), 'examples')
  assert.equal(defaultViewFor('instruct'), 'read')
})

test('the path highlights the step an activity belongs to', () => {
  assert.equal(pathStepFor('warmup'), 'warmup')
  assert.equal(pathStepFor('explainer'), null)
  assert.equal(pathStepFor('teach_back'), 'recall')
  assert.equal(pathStepFor('transfer_quiz'), 'quiz')
  assert.equal(pathStepFor('review'), null)
  assert.equal(pathStepFor('instruct'), null)
  assert.equal(pathStepFor('examples'), null)
  assert.equal(pathStepFor('done_for_now'), null)
})

test('the card steps aside only when the whole address is what is on screen', () => {
  const here = (href: string, path: string, search: string) => opensHere(href, path, new URLSearchParams(search))
  const topic = '/courses/c1/topics/t1'
  assert.equal(here(`${topic}?view=recall`, topic, 'view=recall'), true)
  // "notes" is the Read step.
  assert.equal(here(`${topic}?view=read`, topic, 'view=notes'), true)
  // Same view, other parameters: a different activity.
  assert.equal(here(`${topic}?view=quiz&difficulty=hard`, topic, 'view=quiz'), false)
  assert.equal(here(`${topic}?view=quiz`, topic, 'view=quiz&difficulty=hard'), false)
  assert.equal(here(`${topic}?view=recall&mode=teach_back`, topic, 'view=recall'), false)
  assert.equal(here(`${topic}?view=recall&mode=teach_back`, topic, 'view=recall&mode=teach_back'), true)
  // Pointing the reader at a concept is not the plain reader.
  assert.equal(here(`${topic}?view=read&focus=k1#chunk-c`, topic, 'view=read'), false)
  assert.equal(here(`${topic}?view=read&focus=k1#chunk-c`, topic, 'view=read&focus=k1'), true)
  // Another page, or another view.
  assert.equal(here('/courses/c1/review/session?concept=k', topic, 'view=practice'), false)
  assert.equal(here(`${topic}?view=practice`, topic, 'view=read'), false)
})

test('a bare topic address redirects to the next activity, a named view does not', () => {
  const base = '/courses/c1/topics/t1'
  assert.equal(bareTopicRedirect(base, undefined, { kind: 'warmup', href: `${base}?view=warmup` }), `${base}?view=warmup`)
  assert.equal(bareTopicRedirect(base, 'nonsense', { kind: 'review', href: '/courses/c1/review/session?topic=t1' }), `${base}?view=practice`)
  assert.equal(bareTopicRedirect(base, 'notes', { kind: 'read', href: `${base}?view=read` }), null)
  assert.equal(bareTopicRedirect(base, 'quiz', { kind: 'read', href: `${base}?view=read` }), null)
  // An instruction opens at the concept; "Solid for now" is a card on the topic, not the hard set itself.
  assert.equal(bareTopicRedirect(base, undefined, { kind: 'instruct', href: `${base}?view=read&focus=k1#chunk-c` }), `${base}?view=read&focus=k1#chunk-c`)
  assert.equal(bareTopicRedirect(base, undefined, { kind: 'done_for_now', href: `${base}?view=quiz&difficulty=hard` }), `${base}?view=practice`)
})

test('the view of a request path', () => {
  assert.equal(viewInPath('/courses/c1/topics/t1'), null)
  assert.equal(viewInPath('/courses/c1/topics/t1?view=read&concept=k'), 'read')
  assert.equal(viewInPath('/courses/c1/topics/t1?concept=k&view=quiz'), 'quiz')
  assert.equal(viewInPath(null), null)
})
