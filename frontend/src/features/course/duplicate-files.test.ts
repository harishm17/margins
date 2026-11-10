import assert from 'node:assert/strict'
import test from 'node:test'
import { splitDuplicates } from './duplicate-files'

const known = [
  { id: 'a', filename: 'notes.pdf', sizeBytes: 1000 },
  { id: 'b', filename: 'syllabus.pdf', sizeBytes: 50 },
]

test('a file with the name and size of one in the course is a duplicate, and says which', () => {
  const { fresh, duplicates } = splitDuplicates([{ name: 'notes.pdf', size: 1000 }, { name: 'book.pdf', size: 9 }], known)
  assert.deepEqual(fresh.map((f) => f.name), ['book.pdf'])
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0].matches.map((m) => m.id), ['a'])
})

test('the second copy within one batch is a duplicate with nothing to replace', () => {
  const { fresh, duplicates } = splitDuplicates([{ name: 'new.pdf', size: 5 }, { name: 'new.pdf', size: 5 }], known)
  assert.equal(fresh.length, 1)
  assert.deepEqual(duplicates.map((d) => d.matches.length), [0])
})
