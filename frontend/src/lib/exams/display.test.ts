import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { examTitle, examTitles, splitExamTitle } from './display'

describe('examTitle', () => {
  it('names generated exams "Mock exam" by date and keeps custom names', () => {
    assert.equal(examTitle('Sample Exam - 2026-10-20', '2026-10-20T12:00:00Z'), 'Mock exam, Oct 20')
    assert.equal(examTitle('Mock exam - 2026-10-20', '2026-10-20T12:00:00Z'), 'Mock exam, Oct 20')
    assert.equal(examTitle('Midterm drill', '2026-10-20T12:00:00Z'), 'Midterm drill')
  })
})

describe('examTitles', () => {
  it('tells exams made on the same day apart, in the order they were made', () => {
    const titles = examTitles([
      { id: 'b', name: 'Sample Exam - 2026-10-21', createdAt: '2026-10-21T18:00:00Z' },
      { id: 'a', name: 'Sample Exam - 2026-10-21', createdAt: '2026-10-21T15:00:00Z' },
      { id: 'c', name: 'Sample Exam - 2026-10-21', createdAt: '2026-10-21T19:30:00Z' },
      { id: 'd', name: 'Sample Exam - 2026-10-20', createdAt: '2026-10-20T12:00:00Z' },
    ])
    assert.equal(titles.get('a'), 'Mock exam, Oct 21')
    assert.equal(titles.get('b'), 'Mock exam, Oct 21 (2)')
    assert.equal(titles.get('c'), 'Mock exam, Oct 21 (3)')
    assert.equal(titles.get('d'), 'Mock exam, Oct 20')
  })
})

describe('titles by topics covered', () => {

  it('tells same-day exams apart by topics, and numbers only the ones that still read alike', () => {
    const day = '2026-11-02'
    const titles = examTitles([
      { id: 'a', name: `Mock exam - ${day}`, createdAt: `${day}T10:00:00Z`, topicsCovered: ['Sorting'] },
      { id: 'b', name: `Mock exam - ${day}`, createdAt: `${day}T11:00:00Z`, topicsCovered: ['Hash tables', 'Graphs'] },
      { id: 'c', name: `Mock exam - ${day}`, createdAt: `${day}T12:00:00Z`, topicsCovered: ['Sorting'] },
    ])
    assert.equal(titles.get('a'), 'Mock exam, Nov 2: Sorting')
    assert.equal(titles.get('b'), 'Mock exam, Nov 2: Hash tables, Graphs')
    assert.equal(titles.get('c'), 'Mock exam, Nov 2: Sorting (2)')
  })
})

describe('splitExamTitle', () => {
  it('splits a generated title into a short name and the topics it covers', () => {
    assert.deepEqual(splitExamTitle('Mock exam, Nov 4: Sorting, Hash tables'), { name: 'Mock exam · Nov 4', covers: 'Sorting, Hash tables' })
    assert.deepEqual(splitExamTitle('Mock exam, Nov 4: Sorting and 3 more (2)'), { name: 'Mock exam · Nov 4 (2)', covers: 'Sorting and 3 more' })
    assert.deepEqual(splitExamTitle('Mock exam, Nov 4'), { name: 'Mock exam · Nov 4', covers: null })
    assert.deepEqual(splitExamTitle('Mock exam, Nov 4, 2025: Graphs'), { name: 'Mock exam · Nov 4, 2025', covers: 'Graphs' })
  })
})
