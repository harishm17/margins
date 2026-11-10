import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conceptRecallScores, verdictScore, type ScoredClaim } from './recall-scores'

const claim = (conceptId: string, verdict: ScoredClaim['verdict'], extra: Partial<ScoredClaim> = {}): ScoredClaim => ({ conceptId, verdict, ...extra })

test('verdicts score covered 1, partial 0.5, missing 0 and incorrect 0', () => {
  assert.equal(verdictScore('covered'), 1)
  assert.equal(verdictScore('partial'), 0.5)
  assert.equal(verdictScore('missing'), 0)
  assert.equal(verdictScore('incorrect'), 0)
})

test('concept score is mean of claim verdicts', () => {
  const scores = conceptRecallScores([
    claim('a', 'covered'),
    claim('a', 'partial'),
    claim('a', 'missing'),
    claim('a', 'covered'),
    claim('b', 'incorrect', { kind: 'careless' }),
    claim('c', 'covered'),
    claim('c', 'covered'),
  ])
  assert.deepEqual(
    scores.map((s) => [s.conceptId, s.score]),
    [
      ['a', 0.625],
      ['b', 0],
      ['c', 1],
    ]
  )
})

test('concepts come out in the order their first claim appeared', () => {
  const scores = conceptRecallScores([claim('z', 'missing'), claim('y', 'covered'), claim('z', 'covered')])
  assert.deepEqual(scores.map((s) => s.conceptId), ['z', 'y'])
})

test('incorrect sets misconception', () => {
  const [score] = conceptRecallScores([
    claim('a', 'covered'),
    claim('a', 'incorrect', { misconception: 'A new key overwrites the old one', kind: 'misconception' }),
  ])
  assert.equal(score.missKind, 'misconception')
  assert.equal(score.misconception, 'A new key overwrites the old one')
  // An incorrect claim without a stated kind is a misconception.
  const [unstated] = conceptRecallScores([claim('a', 'incorrect', { misconception: 'Keys never collide' })])
  assert.equal(unstated.missKind, 'misconception')
})

test('the strongest kind of miss names the concept: misconception, then discrimination, then the rest', () => {
  const kinds = (...list: NonNullable<ScoredClaim['kind']>[]) =>
    conceptRecallScores(list.map((kind) => claim('a', 'incorrect', { kind, misconception: `idea ${kind}` })))[0]
  assert.equal(kinds('execution', 'misconception', 'discrimination').missKind, 'misconception')
  assert.equal(kinds('careless', 'discrimination').missKind, 'discrimination')
  assert.equal(kinds('execution', 'careless').missKind, 'execution')
  assert.equal(kinds('careless').missKind, 'careless')
  // The wrong idea comes from the claim that named the kind.
  assert.equal(kinds('careless', 'discrimination').misconception, 'idea discrimination')
})

test('a concept that was only left out is a cue miss, and sets no misconception', () => {
  const [score] = conceptRecallScores([claim('a', 'missing'), claim('a', 'missing'), claim('a', 'covered')])
  assert.equal(score.missKind, 'cue_miss')
  assert.equal(score.misconception, undefined)
})

test('a concept recalled well names no kind of miss', () => {
  const [full] = conceptRecallScores([claim('a', 'covered'), claim('a', 'covered')])
  assert.equal(full.missKind, undefined)
  // Three of four claims is 0.75: a pass, so the one left out is not held against it.
  const [mostly] = conceptRecallScores([claim('a', 'covered'), claim('a', 'covered'), claim('a', 'covered'), claim('a', 'missing')])
  assert.equal(mostly.score, 0.75)
  assert.equal(mostly.missKind, undefined)
})

test('a claim with no concept is left out', () => {
  assert.deepEqual(conceptRecallScores([claim('', 'covered')]), [])
})
