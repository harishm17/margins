import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { coverageNote, examSummary, formatMinutes, formatScore, onlyWithPages, preselectTopics, QUESTION_MIXES } from './exam-options'

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

describe('question mixes', () => {
  it('each one adds up to 100', () => {
    for (const mix of Object.values(QUESTION_MIXES)) {
      const { multiple_choice, short_answer, numerical } = mix.distribution
      assert.equal(multiple_choice + short_answer + numerical, 100)
    }
  })
})

describe('labels', () => {
  it('summarises and formats', () => {
    assert.equal(examSummary({ questionCount: 20, durationMinutes: 60, difficulty: 'medium' }), '20 questions, 1 hr, medium')
    assert.equal(formatMinutes(90), '1 hr 30 min')
    assert.equal(formatMinutes(45), '45 min')
    assert.equal(formatScore(72), '72%')
    assert.equal(formatScore(71.25), '71.3%')
  })
})

describe('onlyWithPages', () => {
  it('drops topics that have no pages, keeping the order', () => {
    assert.deepEqual(onlyWithPages(['a', 'b', 'c'], new Set(['c', 'a'])), ['a', 'c'])
  })
})

describe('coverageNote', () => {
  it('says nothing when no topic is ticked', () => {
    assert.equal(coverageNote(0, 0), null)
  })
  it('counts the topics the exam will cover', () => {
    assert.equal(coverageNote(1, 0), 'Covers 1 topic')
    assert.equal(coverageNote(4, 0), 'Covers 4 topics')
  })
  it('says how many ticked topics are left out for having no pages', () => {
    assert.equal(coverageNote(4, 1), 'Covers 3 topics (1 without pages is left out)')
    assert.equal(coverageNote(5, 2), 'Covers 3 topics (2 without pages are left out)')
    assert.equal(coverageNote(1, 1), 'Covers 0 topics (1 without pages is left out)')
  })
})
