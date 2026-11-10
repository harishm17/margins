import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TranscriptEntry } from './session-state'
import {
  SNAPSHOT_MAX_AGE_MS,
  clearVoiceSnapshot,
  describeSnapshot,
  persistLiveSession,
  readVoiceDraft,
  readVoiceSnapshot,
  resumeOpening,
  snapshotEntries,
  startResume,
  writeVoiceDraft,
  toTranscript,
} from './use-voice-draft'

const memoryStore = () => {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const base = { courseId: 'c1', scope: 't1', mode: 'topic' as const, config: { style: 'oral_quiz' as const, language: 'en', focus: '' } }
const entries: TranscriptEntry[] = [
  { id: 1, role: 'coach', text: 'What is a stack?', streaming: false, interrupted: false },
  { id: 2, role: 'student', text: 'A LIFO structure.', via: 'text' },
  { id: 3, role: 'coach', text: 'Quiet nudge', streaming: false, interrupted: false, note: true },
  { id: 4, role: 'coach', text: 'And a queue?', streaming: false, interrupted: false },
]

describe('voice snapshot', () => {
  it('keeps the lines, the question and the typed draft; leaves out the quiet app lines', () => {
    const store = memoryStore()
    persistLiveSession(base, { entries, question: 'And a queue?' }, store, 1000)
    const snapshot = readVoiceSnapshot('c1', 't1', store, 2000)
    assert.ok(snapshot)
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.text),
      ['What is a stack?', 'A LIFO structure.', 'And a queue?']
    )
    assert.equal(describeSnapshot(snapshot).lastCoach, 'And a queue?')
    assert.equal(describeSnapshot(snapshot).answers, 1)
  })

  it('ignores a snapshot older than 30 minutes, of another scope, or damaged', () => {
    const store = memoryStore()
    persistLiveSession(base, { entries, question: null }, store, 1000)
    assert.equal(readVoiceSnapshot('c1', 't1', store, 1000 + SNAPSHOT_MAX_AGE_MS + 1), null)
    persistLiveSession(base, { entries, question: null }, store, 1000)
    assert.equal(readVoiceSnapshot('c1', 'other', store, 2000), null)
    store.setItem('margins-voice:c1:t1', '{not json')
    assert.equal(readVoiceSnapshot('c1', 't1', store, 2000), null)
    assert.equal(store.getItem('margins-voice:c1:t1'), null)
  })

  it('continuing moves the old lines to restored, keeps the draft, and survives the next write', () => {
    const store = memoryStore()
    persistLiveSession(base, { entries, question: 'And a queue?' }, store, Date.now())
    const held = readVoiceSnapshot('c1', 't1', store)
    assert.ok(held)
    writeVoiceDraft('c1', 't1', 'FIFO, I think', store)
    startResume(readVoiceSnapshot('c1', 't1', store)!, store)
    persistLiveSession(base, { entries: [], question: null }, store)
    const next = readVoiceSnapshot('c1', 't1', store)!
    assert.equal(next.entries.length, 0)
    assert.equal(next.restored.length, 3)
    assert.equal(next.draft, 'FIFO, I think')
    assert.equal(toTranscript(next.restored)[0].id, -1)
  })

  it('asks the coach to repeat the last question, or says nothing when there is none', () => {
    const store = memoryStore()
    persistLiveSession(base, { entries, question: 'And a queue?' }, store, Date.now())
    assert.match(resumeOpening(readVoiceSnapshot('c1', 't1', store)!) ?? '', /ask me this question again.*And a queue\?/)
    assert.equal(resumeOpening({ ...readVoiceSnapshot('c1', 't1', store)!, question: null, entries: [], restored: [] }), null)
  })

  it('keeps typed words even before the first snapshot exists, drops them when stale, and clears with the snapshot', () => {
    const store = memoryStore()
    writeVoiceDraft('c1', 't1', 'half an answer', store, 1000)
    assert.equal(readVoiceDraft('c1', 't1', store, 2000), 'half an answer')
    assert.equal(readVoiceDraft('c1', 't1', store, 1000 + SNAPSHOT_MAX_AGE_MS + 1), '')
    persistLiveSession(base, { entries, question: null }, store, 1500)
    assert.equal(readVoiceSnapshot('c1', 't1', store, 2000)?.draft, 'half an answer')
    clearVoiceSnapshot('c1', 't1', store)
    assert.equal(readVoiceDraft('c1', 't1', store, 2000), '')
    assert.equal(readVoiceSnapshot('c1', 't1', store, 2000), null)
  })

  it('caps long transcripts', () => {
    const many: TranscriptEntry[] = Array.from({ length: 60 }, (_, index) => ({ id: index, role: 'student', text: `a${index}`, via: 'text' }))
    assert.equal(snapshotEntries(many).length, 40)
  })
})
