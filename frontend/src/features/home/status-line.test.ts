import test from 'node:test'
import assert from 'node:assert/strict'
import { activeStatusLine } from './status-line'

test('names the most advanced non-zero level as a count out of all the topics', () => {
  assert.equal(activeStatusLine(['strong', 'strong', 'getting', 'none']), '2 of 4 topics strong')
  assert.equal(activeStatusLine(['strong', 'none', 'none', 'none', 'none']), '1 of 5 topics strong')
  assert.equal(activeStatusLine(['getting', 'learning', 'none']), '1 of 3 topics getting there')
  assert.equal(activeStatusLine(['learning', 'none', 'none']), '1 of 3 topics learning')
  assert.equal(activeStatusLine(['strong']), '1 of 1 topic strong')
})
