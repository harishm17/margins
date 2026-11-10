import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveExamStyleState, type ExamStyleFile } from './style-state'

const file = (id: string, over: Partial<ExamStyleFile> = {}): ExamStyleFile => ({
  id,
  validationStatus: 'valid',
  hasProfile: false,
  ...over,
})

test('one profile is enough: ready, even when another file failed', () => {
  const state = deriveExamStyleState(
    [file('a', { hasProfile: true }), file('b')],
    [{ materialId: 'b', status: 'failed', errorCode: 'LLM_CREDIT_EXHAUSTED' }]
  )
  assert.equal(state.kind, 'ready')
  assert.deepEqual(state.failedFileIds, ['b'])
})

test('a file still being read, or a profile job running: analysing', () => {
  assert.equal(deriveExamStyleState([file('a', { validationStatus: 'pending' })], []).kind, 'analysing')
  assert.equal(
    deriveExamStyleState([file('a')], [{ materialId: 'a', status: 'pending', errorCode: 'LLM_UNAVAILABLE' }]).kind,
    'analysing',
    'a job waiting for its retry is still analysing'
  )
})

test('the latest profile job failed: failed, with its code', () => {
  const state = deriveExamStyleState(
    [file('a')],
    [
      { materialId: 'a', status: 'failed', errorCode: 'LLM_CREDIT_EXHAUSTED' },
      { materialId: 'a', status: 'completed', errorCode: null },
    ]
  )
  assert.equal(state.kind, 'failed')
  assert.equal(state.errorCode, 'LLM_CREDIT_EXHAUSTED')
})

test('only the newest job of a file counts', () => {
  const state = deriveExamStyleState(
    [file('a')],
    [
      { materialId: 'a', status: 'completed', errorCode: null },
      { materialId: 'a', status: 'failed', errorCode: 'LLM_CREDIT_EXHAUSTED' },
    ]
  )
  assert.equal(state.kind, 'unavailable')
})
