import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { copiedHeaders, differing, nameProblems, orderProblems, type ExamQuestion } from './exams'

const q = (topicId: string, type: string, points = 2): ExamQuestion => ({ topicId, type, points, text: 'A question.' })

describe('the order of an exam (U8)', () => {
  const course = ['t1', 't2', 't3']

  it('accepts topics in course order, choice questions before written ones', () => {
    const questions = [q('t1', 'multiple_choice', 1), q('t1', 'true_false', 1), q('t1', 'short_answer', 4), q('t2', 'multiple_choice'), q('t3', 'numerical')]
    assert.deepEqual(orderProblems(questions, course), [])
  })

  it('names a topic that comes back after another one', () => {
    const questions = [q('t1', 'multiple_choice'), q('t2', 'multiple_choice'), q('t1', 'short_answer')]
    assert.deepEqual(orderProblems(questions, course), ['question 3 goes back to an earlier topic'])
  })

  it('names a topic out of course order', () => {
    const questions = [q('t2', 'multiple_choice'), q('t1', 'multiple_choice')]
    assert.deepEqual(orderProblems(questions, course), ['question 2 is on a topic that comes earlier in the course'])
  })

  it('names a choice question after a written one in the same topic', () => {
    const questions = [q('t1', 'short_answer'), q('t1', 'multiple_choice')]
    assert.deepEqual(orderProblems(questions, course), ['question 2 (multiple_choice) comes after a longer question of its topic'])
  })

  it('names an exam that starts on its one highest-point question', () => {
    const questions = [q('t1', 'multiple_choice', 6), q('t2', 'multiple_choice', 2), q('t3', 'multiple_choice', 2)]
    assert.deepEqual(orderProblems(questions, course), ['question 1 is the exam\'s hardest (6 points)'])
  })

  it('does not count a first question that ties for the most points', () => {
    const questions = [q('t1', 'multiple_choice', 2), q('t2', 'multiple_choice', 2)]
    assert.deepEqual(orderProblems(questions, course), [])
  })
})

describe('copied past-exam headers (27)', () => {
  it('names the questions that keep a past exam\'s problem header or points', () => {
    const texts = ['Which of these is true?', '**Problem 3.** Show that it holds.', 'Problem 2: Prove it.', 'Find the bound. [5 points]', 'A problem with 3 parts.']
    assert.deepEqual(copiedHeaders(texts), ['question 2', 'question 3', 'question 4'])
  })
})

describe('one exam name (U7)', () => {
  const short = 'Mock exam · Nov 8'
  const full = 'Mock exam, Nov 8: Sorting and 2 more'

  it('accepts a surface that shows the short or the full name', () => {
    const readings = [
      { surface: 'lobby', text: short },
      { surface: 'plan', text: `${full} · 25 min` },
      { surface: 'results', text: `Results for ${short}` },
    ]
    assert.deepEqual(nameProblems(readings, short, full), [])
  })

  it('names a surface that shows another name', () => {
    const readings = [
      { surface: 'lobby', text: short },
      { surface: 'exam bar', text: 'Sorting · Mock' },
      { surface: 'page title', text: 'Mock exam - Margins' },
    ]
    assert.deepEqual(nameProblems(readings, short, full), ['exam bar: "Sorting · Mock"', 'page title: "Mock exam - Margins"'])
  })
})

describe('one format for one figure (SW4)', () => {
  it('lists every reading when they do not all agree', () => {
    const readings = [
      { surface: 'results', value: '31.8%' },
      { surface: 'list', value: '32%' },
      { surface: 'overview', value: '32%' },
    ]
    assert.deepEqual(differing(readings), ['results: 31.8%', 'list: 32%', 'overview: 32%'])
  })

  it('is empty when they agree', () => {
    assert.deepEqual(differing([{ surface: 'results', value: '40%' }, { surface: 'list', value: '40%' }]), [])
  })
})
