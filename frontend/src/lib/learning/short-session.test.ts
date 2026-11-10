import test from 'node:test'
import assert from 'node:assert/strict'
import { shortSessionLabel, shortSessionPlan, sizeShortSession, type ShortSessionState } from './short-session'

const read = new Date('2026-10-20T10:00:00Z')

const state = (overrides: Partial<ShortSessionState> = {}): ShortSessionState => ({
  courseId: 'c1',
  due: 0,
  currentTopic: { id: 't1', readAt: null, recallAt: null },
  ai: 'up',
  ...overrides,
})

test('due concepts make a six-item review', () => {
  const plan = shortSessionPlan(state({ due: 9 }))
  assert.ok(plan)
  assert.equal(plan.kind, 'review')
  assert.equal(plan.limit, 6)
  assert.equal(plan.retestCap, 2)
  // Fewer due than six: as many as there are.
  const few = shortSessionPlan(state({ due: 2 }))
  assert.equal(few?.limit, 2)
})

test('read but not recalled offers one recall card', () => {
  const plan = shortSessionPlan(state({ currentTopic: { id: 't1', readAt: read, recallAt: null } }))
  assert.ok(plan)
  assert.equal(plan.kind, 'recall')
  assert.equal(plan.minutes, 5)
  assert.equal(plan.href, '/courses/c1/topics/t1?view=recall')
})

test('otherwise a four-question mini quiz', () => {
  const plan = shortSessionPlan(state())
  assert.ok(plan)
  assert.equal(plan.kind, 'mini_quiz')
  assert.equal(plan.limit, 4)
  assert.equal(plan.retestCap, 0)
  // A topic that is read and recalled also gets the mini quiz.
  assert.equal(shortSessionPlan(state({ currentTopic: { id: 't1', readAt: read, recallAt: read } }))?.kind, 'mini_quiz')
})

test('due concepts come before a recall card', () => {
  assert.equal(shortSessionPlan(state({ due: 1, currentTopic: { id: 't1', readAt: read, recallAt: null } }))?.kind, 'review')
})

test('ai down never offers recall', () => {
  const plan = shortSessionPlan(state({ ai: 'down', currentTopic: { id: 't1', readAt: read, recallAt: null } }))
  assert.ok(plan)
  assert.equal(plan.kind, 'mini_quiz')
  // Reviews and the mini quiz still run, on items graded by rule.
  assert.equal(shortSessionPlan(state({ ai: 'down', due: 4 }))?.kind, 'review')
})

test('nothing due and no current topic offers nothing', () => {
  assert.equal(shortSessionPlan(state({ currentTopic: null })), null)
})

test('the estimate: reviews and the mini quiz by the item, a recall card five minutes', () => {
  assert.equal(shortSessionPlan(state({ due: 6 }))?.minutes, 9)
  assert.equal(shortSessionPlan(state())?.minutes, 6)
  // With the AI down every item is graded by rule: a minute each.
  assert.equal(shortSessionPlan(state({ due: 6, ai: 'down' }))?.minutes, 6)
})

test('the labels read as the copy draft', () => {
  assert.equal(shortSessionLabel(shortSessionPlan(state({ due: 6 }))!), 'About 9 minutes · 6 reviews')
  assert.equal(shortSessionLabel(shortSessionPlan(state({ due: 1 }))!), 'About 2 minutes · 1 review')
  assert.equal(shortSessionLabel(shortSessionPlan(state({ currentTopic: { id: 't1', readAt: read, recallAt: null } }))!), 'About 5 minutes · one recall card')
  assert.equal(shortSessionLabel(shortSessionPlan(state())!), 'About 6 minutes · 4 questions')
})

test('the card says the size the session really has, not the ceiling', () => {
  const review = shortSessionPlan(state({ due: 9 }))!
  // Six due but only four questions ready and nothing to write: four, exactly.
  const four = sizeShortSession(review, { ready: 4, toWrite: 0 }, 'up')
  assert.deepEqual(four.size, { count: 4, exact: true })
  assert.equal(four.minutes, 6)
  assert.equal(shortSessionLabel(four), 'About 6 minutes · 4 reviews')
  // Some still to be written: up to six.
  const upTo = sizeShortSession(review, { ready: 3, toWrite: 3 }, 'up')
  assert.equal(shortSessionLabel(upTo), 'About 9 minutes · up to 6 reviews')
  // More available than the ceiling: the ceiling.
  assert.equal(sizeShortSession(review, { ready: 12, toWrite: 0 }, 'up').size?.count, 6)
  // The mini quiz card says up to when a question is still to be written.
  const quiz = shortSessionPlan(state())!
  assert.equal(shortSessionLabel(sizeShortSession(quiz, { ready: 3, toWrite: 0 }, 'up')), 'About 5 minutes · 3 questions')
  assert.equal(shortSessionLabel(sizeShortSession(quiz, { ready: 2, toWrite: 2 }, 'up')), 'About 6 minutes · up to 4 questions')
})
