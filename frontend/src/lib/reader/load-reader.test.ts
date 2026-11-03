import assert from 'node:assert/strict'
import test from 'node:test'
import { toNoteView } from './load-reader'

const row = (kind: string, reply: unknown) => ({ id: 'n1', chunkId: 'c1', kind, text: 'My answer', reply, createdAt: new Date('2026-11-01T10:00:00Z') })

test('an answer keeps its kind, its verdict and the note it answers', () => {
  const view = toNoteView(row('answer', { reply: 'You have half of it.', checkQuestion: 'And the second key?', verdict: 'partly', parentNoteId: 'q1' }))
  assert.equal(view.kind, 'answer')
  assert.equal(view.verdict, 'partly')
  assert.equal(view.parentNoteId, 'q1')
  assert.deepEqual(view.reply, { reply: 'You have half of it.', checkQuestion: 'And the second key?' })
})

test('an answer the tutor could not check has no verdict', () => {
  const view = toNoteView(row('answer', { reply: 'Try again later.', checkQuestion: '', verdict: null, parentNoteId: 'q1' }))
  assert.equal(view.kind, 'answer')
  assert.equal(view.verdict, null)
})

test('an unknown verdict is dropped, and notes and questions carry neither verdict nor parent', () => {
  assert.equal(toNoteView(row('answer', { reply: 'x', verdict: 'great', parentNoteId: 'q1' })).verdict, null)
  for (const kind of ['note', 'question']) {
    const view = toNoteView(row(kind, { reply: 'x', checkQuestion: '', verdict: 'right', parentNoteId: 'q1' }))
    assert.equal(view.kind, kind)
    assert.equal(view.verdict, null)
    assert.equal(view.parentNoteId, null)
  }
  assert.equal(toNoteView(row('other', null)).kind, 'note')
})
