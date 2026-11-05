import assert from 'node:assert/strict'
import test from 'node:test'
import { nextLineShows, nextPathStep } from './activity-copy'
import { pathGlyphs } from './path-steps'

const STEPS = ['warmup', 'read', 'recall', 'practice', 'quiz'] as const
const none = { warmup: false, read: false, recall: false, practice: false, quiz: false }
const base = '/courses/c1/topics/t1'

test('the Next tag is on the activity step while it is not done, else on the first step not done', () => {
  const warmup = { kind: 'warmup' as const, href: `${base}?view=warmup` }
  assert.equal(nextPathStep(warmup, STEPS, none), 'warmup')
  const practice = { kind: 'practice' as const, href: `${base}?view=practice` }
  // The activity's step is done: the first step that is not done, not a stale step.
  assert.equal(nextPathStep(practice, STEPS, { ...none, warmup: true, read: true, recall: true, practice: true }), 'quiz')
  assert.equal(nextPathStep(practice, STEPS, { warmup: true, read: true, recall: true, practice: true, quiz: true }), null)
  // A drill, a review or a mock exam is no step: the tag is on the first step not done.
  assert.equal(nextPathStep({ kind: 'review', href: '/courses/c1/review/session?topic=t1' }, STEPS, { ...none, warmup: true }), 'read')
  // Reading a missed idea again is Read; the explainer is no step.
  assert.equal(nextPathStep({ kind: 'instruct', href: `${base}?view=read&focus=k1` }, STEPS, { ...none, warmup: true }), 'read')
  assert.equal(nextPathStep({ kind: 'instruct', href: `${base}?view=explainer&focus=k1` }, STEPS, { ...none, warmup: true, read: true }), 'recall')
  // A step the topic does not offer is never tagged.
  assert.equal(nextPathStep({ kind: 'recall', href: `${base}?view=recall` }, ['read', 'practice', 'quiz'], none), 'read')
})

test('the Next line shows on a tool, never on a step with an action of its own, except for a next activity that is no step', () => {
  const reread = { kind: 'instruct' as const, href: `${base}?view=read&focus=k1` }
  // Re-reading a missed idea does not put a line on every step.
  for (const step of STEPS) assert.equal(nextLineShows(reread, step, STEPS), false, step)
  assert.equal(nextLineShows(reread, 'examples', STEPS), true)
  assert.equal(nextLineShows(reread, 'voice', STEPS), true)
  // A step's own next activity is the tag, not a line.
  assert.equal(nextLineShows({ kind: 'warmup', href: `${base}?view=warmup` }, 'read', STEPS), false)
  assert.equal(nextLineShows({ kind: 'quiz', href: `${base}?view=quiz` }, 'examples', STEPS), true)
  // A drill lands on Practice, and only there is it said.
  const drill = { kind: 'fix_misconception' as const, href: '/courses/c1/review/session?concept=k1' }
  assert.equal(nextLineShows(drill, 'practice', STEPS), true)
  assert.equal(nextLineShows(drill, 'quiz', STEPS), false)
  assert.equal(nextLineShows(drill, 'examples', STEPS), true)
  // A topic nobody has opened has nothing to say yet.
  assert.equal(nextLineShows({ kind: 'start', href: base }, 'examples', STEPS), false)
})

test('after Recall the explainer detour tags Practice, and its own page shows no Next line pointing at itself', () => {
  const explainer = { kind: 'instruct' as const, href: `${base}?view=explainer&focus=k1` }
  const recalled = { warmup: true, read: true, recall: true, practice: false, quiz: false }
  // The path and the button agree: the detour leads on to Practice, so Practice is tagged and the way on from the explanation is Practice.
  assert.equal(nextPathStep(explainer, STEPS, recalled), 'practice')
  // On the explainer, the line that points at the explainer is left off; on another tool it still shows.
  assert.equal(nextLineShows(explainer, 'explainer', STEPS, true), false)
  assert.equal(nextLineShows(explainer, 'examples', STEPS, false), true)
  // The explainer has its own way on, so no next activity puts a line over its gap questions.
  assert.equal(nextLineShows({ kind: 'quiz', href: `${base}?view=quiz` }, 'explainer', STEPS, false), false)
})

test('a row of the Topics list names the step the path tags', () => {
  const done = { ...none, warmup: true }
  const next = nextPathStep({ kind: 'instruct', href: `${base}?view=read&focus=k1` }, STEPS, done)
  const glyphs = pathGlyphs({ steps: [...STEPS], done, nextStep: next })
  assert.deepEqual(glyphs.map((glyph) => glyph.state), ['done', 'next', 'later', 'later', 'later'])
})
