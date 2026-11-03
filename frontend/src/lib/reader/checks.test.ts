import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChecks, checkScore, sectionsOf, type ReaderClaimRef, type ReaderPassageRef } from './checks'
import { demoteHeadings } from './passage-text'

const passage = (n: number, over: Partial<ReaderPassageRef> = {}): ReaderPassageRef => ({
  chunkId: `c${n}`,
  materialId: 'm1',
  sectionHierarchy: 'Hashing',
  ...over,
})

const claim = (id: string, chunkId: string | null, conceptName = 'Hash function'): ReaderClaimRef => ({
  id,
  conceptId: `concept-${id}`,
  conceptName,
  text: `${conceptName} claim ${id}.`,
  quote: `quote ${id}`,
  chunkId,
  pageStart: 4,
})

test('sections follow the headings of a file and are capped in length', () => {
  const passages = [
    passage(1),
    passage(2),
    passage(3, { sectionHierarchy: 'Collisions' }),
    passage(4, { materialId: 'm2', sectionHierarchy: 'Collisions' }),
    ...[5, 6, 7, 8, 9].map((n) => passage(n, { materialId: 'm3', sectionHierarchy: null })),
  ]
  assert.deepEqual(
    sectionsOf(passages).map((section) => section.map((p) => p.chunkId)),
    [['c1', 'c2'], ['c3'], ['c4'], ['c5', 'c6', 'c7', 'c8'], ['c9']]
  )
})

test('one before-you-go-on check per section with a claim, skippable, self-graded level 2', () => {
  const passages = [passage(1), passage(2), passage(3, { sectionHierarchy: 'Collisions' }), passage(4, { sectionHierarchy: 'Probing' })]
  // Two claims in the first section, one in the second, none in the third.
  const claims = [claim('a', 'c1'), claim('b', 'c2', 'Load factor'), claim('c', 'c3', 'Chaining')]
  const checks = buildChecks(passages, claims, [])
  assert.equal(checks.length, 2)
  // Never more than one per section, placed after the section's last passage.
  assert.deepEqual(checks.map((c) => c.afterChunkId), ['c2', 'c3'])
  assert.deepEqual(checks.map((c) => c.claim.id), ['a', 'c'])
  // A claim turned into a question; the source sentence is held back for the reveal.
  assert.equal(checks[0].kind, 'claim')
  assert.equal(checks[0].question, 'What does the reading say about Hash function?')
  assert.equal(checks[0].claim.quote, 'quote a')
  // Self-graded: Got it, Partly, Missed.
  assert.deepEqual([checkScore('got_it'), checkScore('partly'), checkScore('missed')], [1, 0.5, 0])
})

test('a section uses its focus question when one points into it', () => {
  const passages = [passage(1), passage(2)]
  const claims = [claim('a', 'c1'), claim('b', 'c2', 'Load factor')]
  const focus = [
    { objectiveIndex: 0, question: 'When does a table need to grow?', chunkId: 'c2' },
    { objectiveIndex: 1, question: 'Elsewhere?', chunkId: 'gone' },
  ]
  const [check] = buildChecks(passages, claims, focus)
  assert.equal(check.kind, 'focus')
  assert.equal(check.question, 'When does a table need to grow?')
  // The reveal is the claim in the chunk the focus question points at.
  assert.equal(check.claim.id, 'b')
})

test('no claims, no checks: a topic from before concepts reads with none', () => {
  assert.deepEqual(buildChecks([passage(1), passage(2)], [], []), [])
  // Claims whose chunk is not in the reading (a file processed again) add nothing.
  assert.deepEqual(buildChecks([passage(1)], [claim('a', 'old'), claim('b', null)], []), [])
})

test('headings of a passage sit below the page headings', () => {
  assert.equal(demoteHeadings('# Title\n\nText\n\n## Part\n\n###### Deep'), '## Title\n\nText\n\n### Part\n\n###### Deep')
  // Code fences and lines that only look like headings are left alone.
  assert.equal(demoteHeadings('```python\n# a comment\n```\n#hashtag'), '```python\n# a comment\n```\n#hashtag')
})
