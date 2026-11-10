import assert from 'node:assert/strict'
import test from 'node:test'
import { isRecordId } from './ids'

test('UUIDs and cuid-like ids are usable', () => {
  assert.equal(isRecordId('bef80f25-a96d-446b-bdac-08316f60791d'), true)
  assert.equal(isRecordId('clx9y2k3a0000abcd1234efgh'), true)
})

test('anything else is not, including a NUL byte, which the database rejects', () => {
  assert.equal(isRecordId('\u0000'), false)
  assert.equal(isRecordId('abc\u0000def'), false)
  assert.equal(isRecordId(''), false)
  assert.equal(isRecordId('a'.repeat(65)), false)
  assert.equal(isRecordId('../etc/passwd'), false)
  assert.equal(isRecordId("x' or '1'='1"), false)
  assert.equal(isRecordId(undefined), false)
  assert.equal(isRecordId(42), false)
})
