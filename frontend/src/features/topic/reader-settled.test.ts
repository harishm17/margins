import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettled } from './reader-settled'

test('a stored grade with no counted field (saved before the field existed) is counted', () => {
  assert.deepEqual(parseSettled('{"state":"done","grade":"got_it"}'), { state: 'done', grade: 'got_it', counted: true })
})

test('skipped, junk and unknown grades', () => {
  assert.deepEqual(parseSettled('{"state":"skipped"}'), { state: 'skipped' })
  assert.equal(parseSettled(null), null)
  assert.equal(parseSettled('not json'), null)
  assert.equal(parseSettled('{"state":"done","grade":"great"}'), null)
})
