import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BADGE_RADIUS, layoutMap, NODE_HEIGHT, NODE_WIDTH, PAIR_GAP } from './layout'

const nodes = (...ids: string[]) => ids.map((id) => ({ id }))
const edge = (sourceId: string, targetId: string, type = 'prerequisite') => ({ sourceId, targetId, type })

test('prerequisites rank above dependents', () => {
  const { positions } = layoutMap(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')])
  assert.ok(positions.a.y < positions.b.y)
  assert.ok(positions.b.y < positions.c.y)
})

test('an encompassed concept ranks above the advanced one that exercises it', () => {
  // The source encompasses (is more advanced than) the target, so the target comes first.
  const { positions } = layoutMap(nodes('advanced', 'basic'), [edge('advanced', 'basic', 'encompasses')])
  assert.ok(positions.basic.y < positions.advanced.y)
})

test('confusables do not change ranks', () => {
  const ranked = [edge('a', 'b'), edge('b', 'c')]
  const without = layoutMap(nodes('a', 'b', 'c'), ranked)
  // c is a near-twin of a: a rank-changing edge would pull one of them to the other's row.
  const withTwin = layoutMap(nodes('a', 'b', 'c'), [...ranked, edge('a', 'c', 'confusable')])
  for (const id of ['a', 'b', 'c']) assert.equal(withTwin.positions[id].y, without.positions[id].y)
  assert.ok(withTwin.positions.a.y < withTwin.positions.c.y)
})

test('every node gets a position inside the reported size, edges to unknown nodes are ignored', () => {
  const { positions, width, height } = layoutMap(nodes('a', 'b', 'lone'), [edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b', 'confusable')])
  assert.deepEqual(Object.keys(positions).sort(), ['a', 'b', 'lone'])
  for (const p of Object.values(positions)) {
    assert.ok(p.x - NODE_WIDTH / 2 >= 0 && p.x + NODE_WIDTH / 2 <= width)
    assert.ok(p.y - NODE_HEIGHT / 2 >= 0 && p.y + NODE_HEIGHT / 2 <= height)
  }
})

test('an empty map has no positions and no size', () => {
  assert.deepEqual(layoutMap([], []), { positions: {}, width: 0, height: 0 })
})

test('a cycle among suggested links still lays out', () => {
  const { positions } = layoutMap(nodes('a', 'b'), [edge('a', 'b'), edge('b', 'a')])
  assert.equal(Object.keys(positions).length, 2)
})

test('a cycle that mixes prerequisite and encompasses links still lays out', () => {
  // b encompasses a (so a sits above b) while c, needed by b, needs b's dependent a: a loop across both types.
  const { positions } = layoutMap(nodes('a', 'b', 'c'), [edge('b', 'a', 'encompasses'), edge('b', 'c'), edge('c', 'a')])
  assert.deepEqual(Object.keys(positions).sort(), ['a', 'b', 'c'])
  for (const p of Object.values(positions)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})

test('two ideas that are easy to mix up on one row are far enough apart for the badge between their boxes', () => {
  const gap = (edges: ReturnType<typeof edge>[]) => {
    const { positions } = layoutMap(nodes('p', 'a', 'b'), [edge('p', 'a'), edge('p', 'b'), ...edges])
    return Math.abs(positions.a.x - positions.b.x) - NODE_WIDTH
  }
  assert.ok(gap([]) < PAIR_GAP, 'without the pair mark they sit closer')
  assert.ok(gap([edge('a', 'b', 'confusable')]) >= PAIR_GAP)
  assert.ok(PAIR_GAP >= BADGE_RADIUS * 2 + 16, 'the badge has air on both sides')
})
