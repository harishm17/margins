import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeKeywordLists, moveInOrder } from './ordering'

test('moves an id forward and back', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveInOrder(['a', 'b', 'c', 'd'], 'd', 1), ['a', 'd', 'b', 'c'])
})

test('an unknown id leaves the order alone, and the input is not changed', () => {
  const ids = ['a', 'b']
  assert.deepEqual(moveInOrder(ids, 'x', 0), ['a', 'b'])
  moveInOrder(ids, 'b', 0)
  assert.deepEqual(ids, ['a', 'b'])
})

test('merged keywords drop case-insensitive repeats and blanks', () => {
  assert.deepEqual(
    mergeKeywordLists(['Stack', 'heap'], ['stack', ' Queue ', '']),
    ['Stack', 'heap', 'Queue']
  )
})
