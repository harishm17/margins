import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JOB_STATUS_SELECT, serializeJob, type JobStatusRow } from './status'

describe('job status response', () => {
  it('never selects inputData, which can hold a student\'s exam answers', () => {
    assert.equal('inputData' in JOB_STATUS_SELECT, false)
    assert.equal(JOB_STATUS_SELECT.status, true)
    assert.equal(JOB_STATUS_SELECT.resultData, true)
  })
})
