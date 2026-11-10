import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUploadUrl, uploadErrorMessage } from './upload-file'

test('the upload URL carries the category and an encoded file name', () => {
  const url = buildUploadUrl('p1', 'lecture_notes', 'Week 3 & 4 (final).pdf')
  const parsed = new URL(url, 'http://localhost')
  assert.equal(parsed.pathname, '/api/projects/p1/materials')
  assert.equal(parsed.searchParams.get('category'), 'lecture_notes')
  assert.equal(parsed.searchParams.get('filename'), 'Week 3 & 4 (final).pdf')
})

test('an API error message is passed on as written', () => {
  assert.equal(uploadErrorMessage(400, { error: 'Unsupported file type.' }, 25), 'Unsupported file type.')
  assert.equal(uploadErrorMessage(500, { error: { message: 'Nested message' } }, 25), 'Nested message')
})

test('a 413 without a body still names the limit', () => {
  assert.equal(uploadErrorMessage(413, null, 25), 'File must be 25 MB or smaller.')
})
