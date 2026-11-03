import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearDraft, draftKey, markRecallAbandoned, openDraft, parseRecallPayload, readDraft, writeText } from './recall-draft'

class FakeStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

test('a draft keeps the text a student wrote until the answer is graded', () => {
  const storage = new FakeStorage()
  assert.deepEqual(readDraft(storage, 't1', 'o0'), { text: '', abandoned: false, voice: false, open: false })
  writeText(storage, 't1', 'o0', 'A hash table maps keys', false)
  assert.deepEqual(readDraft(storage, 't1', 'o0'), { text: 'A hash table maps keys', abandoned: false, voice: false, open: true })
  // A 503 keeps the draft: it is read back as it was written.
  assert.equal(readDraft(storage, 't1', 'o0').text, 'A hash table maps keys')
  clearDraft(storage, 't1', 'o0')
  assert.equal(readDraft(storage, 't1', 'o0').open, false)
})

test('opening the reader abandons every open card of the topic and no other', () => {
  const storage = new FakeStorage()
  openDraft(storage, 't1', 'o0')
  writeText(storage, 't1', 'o1', 'something', true)
  openDraft(storage, 't2', 'o0')
  assert.equal(markRecallAbandoned(storage, 't1'), 2)
  assert.equal(readDraft(storage, 't1', 'o0').abandoned, true)
  assert.equal(readDraft(storage, 't1', 'o1').abandoned, true)
  // Typing on afterwards does not clear it, and the voice flag survives.
  writeText(storage, 't1', 'o1', 'something more', true)
  assert.deepEqual(readDraft(storage, 't1', 'o1'), { text: 'something more', abandoned: true, voice: true, open: true })
  assert.equal(readDraft(storage, 't2', 'o0').abandoned, false)
})

test('opening the reader with no card open abandons nothing', () => {
  const storage = new FakeStorage()
  assert.equal(markRecallAbandoned(storage, 't1'), 0)
  assert.equal(storage.length, 0)
})

test('a damaged draft reads as empty', () => {
  const storage = new FakeStorage()
  storage.setItem(draftKey('t1', 'o0'), '{not json')
  assert.equal(readDraft(storage, 't1', 'o0').open, false)
  storage.setItem(draftKey('t1', 'o0'), JSON.stringify({ text: 5, abandoned: 'yes' }))
  assert.deepEqual(readDraft(storage, 't1', 'o0'), { text: '', abandoned: false, voice: false, open: true })
})

test('storage that refuses to write does not break the page', () => {
  const refusing = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new Error('quota')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  assert.doesNotThrow(() => writeText(refusing, 't1', 'o0', 'x', false))
  assert.doesNotThrow(() => clearDraft(refusing, 't1', 'o0'))
  assert.equal(markRecallAbandoned(refusing, 't1'), 0)
})

test('a server draft is read back as text and voice, and anything else is not a draft', () => {
  assert.deepEqual(parseRecallPayload({ text: 'hello', voice: true }), { text: 'hello', voice: true })
  assert.deepEqual(parseRecallPayload({ text: 'hello' }), { text: 'hello', voice: false })
  assert.equal(parseRecallPayload({ voice: true }), null)
  assert.equal(parseRecallPayload('text'), null)
  assert.equal(parseRecallPayload(null), null)
})
