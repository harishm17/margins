import test from 'node:test'
import assert from 'node:assert/strict'
import { originalHref } from './original-href'

test('a PDF source opens at the first page of its range', () => {
  assert.equal(originalHref({ materialId: 'm1', filename: 'algorithms.pdf', pageStart: 1 }), '/api/materials/m1/file#page=1')
  assert.equal(originalHref({ materialId: 'm1', filename: 'algorithms.PDF', pageStart: 7 }), '/api/materials/m1/file#page=7')
})

test('a file without pages, or one that is not a PDF, opens from the start', () => {
  assert.equal(originalHref({ materialId: 'm1', filename: 'algorithms.pdf', pageStart: null }), '/api/materials/m1/file')
  assert.equal(originalHref({ materialId: 'm2', filename: 'slides.pptx', pageStart: 4 }), '/api/materials/m2/file')
})

test('a source with no file id has no address', () => {
  assert.equal(originalHref({ materialId: null, filename: 'old.pdf', pageStart: 2 }), null)
})
