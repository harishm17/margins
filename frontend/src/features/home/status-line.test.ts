import test from 'node:test'
import assert from 'node:assert/strict'
import { activeStatusLine, hasMasteryColours } from './status-line'

test('names the most advanced non-zero bucket', () => {
  assert.equal(activeStatusLine(['strong', 'strong', 'getting', 'none']), '4 topics, 2 strong')
  assert.equal(activeStatusLine(['getting', 'learning', 'none']), '3 topics, 1 getting there')
  assert.equal(activeStatusLine(['learning', 'none', 'none']), '3 topics, 1 learning')
})

test('says only the topic count when nothing has started, and never names an empty bucket', () => {
  assert.equal(activeStatusLine(['none', 'none']), '2 topics')
  assert.equal(activeStatusLine(['none']), '1 topic')
  assert.ok(!activeStatusLine(['getting']).includes('0 strong'))
})

test('the colour legend waits until a topic has started', () => {
  assert.equal(hasMasteryColours([]), false)
  assert.equal(hasMasteryColours([[], []]), false)
  assert.equal(hasMasteryColours([['none', 'none', 'none']]), false)
  assert.equal(hasMasteryColours([['none'], ['none', 'learning']]), true)
})
