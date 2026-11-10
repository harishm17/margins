import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { examDefaultsFromParams, topicsFromParam } from './form-defaults'

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
})

describe('topicsFromParam', () => {
  const valid = ['a', 'b', 'c']
  it('ticks exactly the named topics, in course order', () => {
    assert.deepEqual(topicsFromParam('c,a', valid), ['a', 'c'])
    assert.deepEqual(topicsFromParam(['b'], valid), ['b'])
  })
  it('ignores unknown or unconfirmed ids, and falls back when none remain', () => {
    assert.deepEqual(topicsFromParam('a,zzz,new-topic', valid), ['a'])
    assert.equal(topicsFromParam('zzz,new-topic', valid), null)
    assert.equal(topicsFromParam('', valid), null)
    assert.equal(topicsFromParam(undefined, valid), null)
  })
})
