import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapName } from './wrap'

test('a short name stays on one line', () => {
  assert.deepEqual(wrapName('Hash tables', 24, 2), ['Hash tables'])
})

test('a longer name breaks at a space', () => {
  assert.deepEqual(wrapName('Amortised cost of dynamic arrays', 20, 2), ['Amortised cost of', 'dynamic arrays'])
})

test('a name that does not fit in the lines ends in an ellipsis', () => {
  const lines = wrapName('Breadth first search on weighted directed graphs with negative cycles', 20, 2)
  assert.equal(lines.length, 2)
  assert.ok(lines[1].endsWith('…'))
  assert.ok(lines.every((line) => line.length <= 20))
})

test('one very long word is cut', () => {
  assert.deepEqual(wrapName('Pneumonoultramicroscopicsilicovolcanoconiosis', 12, 2), ['Pneumonoult…'])
})
