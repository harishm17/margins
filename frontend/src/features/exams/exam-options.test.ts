import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { preselectTopics } from './exam-options'

const NOW = Date.parse('2026-10-20T12:00:00Z')

describe('preselectTopics', () => {
  it('picks topics that are due or below strong, and those with no signal', () => {
    const picked = preselectTopics(
      [
        { id: 'strong', mastery: 0.9, dueAt: '2026-11-01T00:00:00Z' },
        { id: 'strong-due', mastery: 0.9, dueAt: '2026-10-19T00:00:00Z' },
        { id: 'learning', mastery: 0.3, dueAt: null },
        { id: 'new', mastery: null, dueAt: null },
      ],
      NOW
    )
    assert.deepEqual(picked, ['strong-due', 'learning', 'new'])
  })

  it('picks everything when every topic is strong and not due', () => {
    const picked = preselectTopics(
      [
        { id: 'a', mastery: 0.85, dueAt: '2026-11-01T00:00:00Z' },
        { id: 'b', mastery: 0.95, dueAt: null },
      ],
      NOW
    )
    assert.deepEqual(picked, ['a', 'b'])
  })
})
