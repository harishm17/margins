import assert from 'node:assert/strict'
import test from 'node:test'
import { freshHardSet, isHardQuizSet } from './quiz-hard'

const q = (difficulty: string | undefined) => ({ difficulty }) as never
const set = (id: string, createdAt: string, levels: (string | undefined)[], kind: 'standard' | 'retry' = 'standard') => ({
  id,
  kind,
  createdAt,
  questions: levels.map(q),
})

test('transfer quiz opens a fresh hard set: the newest hard standard set with no attempt', () => {
  const sets = [
    set('old', '2026-10-01', ['hard']),
    set('mixed', '2026-10-02', ['hard', 'easy']),
    set('new', '2026-10-03', ['hard', 'hard']),
    set('retry', '2026-10-04', ['hard'], 'retry'),
  ]
  assert.equal(freshHardSet(sets, []), 'new')
  assert.equal(freshHardSet(sets, [{ setId: 'new' }]), 'old')
  assert.equal(freshHardSet(sets, [{ setId: 'new' }, { setId: 'old' }]), null)
})
