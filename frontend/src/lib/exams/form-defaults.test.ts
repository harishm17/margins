import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { examDefaultsFromParams, questionsForMinutes, QUESTION_COUNTS, TIME_LIMITS } from './form-defaults'

describe('examDefaultsFromParams', () => {
  it('keeps the form defaults without parameters', () => {
    assert.deepEqual(examDefaultsFromParams({}), { durationMinutes: 60, totalQuestions: 20 })
  })

  it('takes the length of a mixed practice block and a matching question count', () => {
    assert.deepEqual(examDefaultsFromParams({ minutes: '15' }), { durationMinutes: 15, totalQuestions: 5 })
    assert.deepEqual(examDefaultsFromParams({ minutes: '20', questions: '5' }), { durationMinutes: 20, totalQuestions: 5 })
    assert.deepEqual(examDefaultsFromParams({ minutes: '30' }), { durationMinutes: 30, totalQuestions: 10 })
  })

  it('clamps to the choices on the form; a tie goes to the shorter time', () => {
    assert.equal(examDefaultsFromParams({ minutes: '25' }).durationMinutes, 20)
    assert.equal(examDefaultsFromParams({ minutes: '28' }).durationMinutes, 30)
    assert.equal(examDefaultsFromParams({ minutes: '5' }).durationMinutes, 15)
    assert.equal(examDefaultsFromParams({ minutes: '9999' }).durationMinutes, 180)
    assert.equal(examDefaultsFromParams({ questions: '1000' }).totalQuestions, 40)
    assert.equal(examDefaultsFromParams({ questions: '1' }).totalQuestions, 5)
  })

  it('ignores junk', () => {
    for (const junk of ['', 'abc', '-20', '0', '2e1', '20.5', ' 20', '99999', '20;drop', 'NaN']) {
      assert.deepEqual(examDefaultsFromParams({ minutes: junk, questions: junk }), { durationMinutes: 60, totalQuestions: 20 }, junk)
    }
    assert.deepEqual(examDefaultsFromParams({ minutes: ['20', '90'] }), { durationMinutes: 20, totalQuestions: 5 })
    assert.deepEqual(examDefaultsFromParams({ minutes: undefined, questions: undefined }), { durationMinutes: 60, totalQuestions: 20 })
  })

  it('always returns a choice the form has', () => {
    for (let minutes = 0; minutes <= 400; minutes += 1) {
      const { durationMinutes, totalQuestions } = examDefaultsFromParams({ minutes: String(minutes) })
      assert.ok((TIME_LIMITS as readonly number[]).includes(durationMinutes))
      assert.ok((QUESTION_COUNTS as readonly number[]).includes(totalQuestions))
    }
  })
})

describe('questionsForMinutes', () => {
  it('follows the default pace of 3 minutes a question', () => {
    assert.equal(questionsForMinutes(60), 20)
    assert.equal(questionsForMinutes(90), 30)
    assert.equal(questionsForMinutes(15), 5)
  })

  it('covers every block length of the plan (15 to 30 minutes)', () => {
    for (let minutes = 15; minutes <= 30; minutes += 1) {
      const questions = questionsForMinutes(minutes)
      assert.ok(questions >= 5 && questions <= 10, `${minutes} min gives ${questions}`)
    }
  })
})
