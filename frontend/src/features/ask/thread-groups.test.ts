import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupThreads } from './thread-groups'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

describe('groupThreads', () => {
  it('splits threads into Today, Last 7 days and Earlier by age', () => {
    const groups = groupThreads(
      [
        { id: 'a', title: 'A', updatedAt: ago(1) },
        { id: 'b', title: 'B', updatedAt: ago(30) },
        { id: 'c', title: 'C', updatedAt: ago(24 * 6) },
        { id: 'd', title: 'D', updatedAt: ago(24 * 9) },
      ],
      NOW
    )
    assert.deepEqual(
      groups.map((group) => [group.label, group.threads.map((thread) => thread.id)]),
      [
        ['Today', ['a']],
        ['Last 7 days', ['b', 'c']],
        ['Earlier', ['d']],
      ]
    )
  })
})
