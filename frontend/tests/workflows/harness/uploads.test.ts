import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { estimateProblems, estimateSeconds, settled, type Moment } from './uploads'

/** A watched upload whose status was `statuses[i]` at `i` seconds. */
const moments = (statuses: string[]): Moment[] =>
  statuses.map((status, second) => ({ at: second * 1000, rows: [{ name: 'quiz-1.pdf 12 KB', status }], cutOff: [] }))

describe('upload statuses', () => {
  it('reads the estimate in each wording the upload list uses', () => {
    assert.equal(estimateSeconds('Reading pages, step 2 of 3, 12s, usually about 35 seconds'), 35)
    assert.equal(estimateSeconds('Checking the file, step 1 of 3, usually a few seconds'), 10)
    assert.equal(estimateSeconds('Reading pages, step 2 of 3, usually about a minute'), 60)
    assert.equal(estimateSeconds('Reading pages, step 2 of 3, usually about 3 minutes'), 180)
    assert.equal(estimateSeconds('Reading pages, step 2 of 3, 50s, taking longer than usual'), null)
    assert.equal(estimateSeconds('Ready'), null)
  })

  it('counts a file as settled once it is ready or shows a problem, not while it uploads or is read', () => {
    assert.equal(settled('Ready'), true)
    assert.equal(settled('This PDF has no selectable text. Remove it'), true)
    assert.equal(settled('Uploading 40%'), false)
    assert.equal(settled('Getting your pages ready for study and search, step 3 of 3'), false)
    assert.equal(settled(''), false)
  })
})

describe('estimate problems', () => {
  const kept = moments(['Uploading 50%', 'Checking the file, step 1 of 3, usually about 2 seconds', 'Reading pages, step 2 of 3', 'Ready'])
  it('accepts an estimate kept to within twice its time', () => {
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: true, moments: kept }), [])
  })

  const late = ['Reading pages, step 2 of 3, usually a few seconds', ...Array(24).fill('Reading pages, step 2 of 3'), 'Ready']
  it('reports an estimate overrun with no word that the file is late', () => {
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: true, moments: moments(late) }), [
      'quiz-1.pdf: said about 10 s, took 25 s and never said it was late',
    ])
  })
  it('accepts an overrun the status owns up to', () => {
    const owned = [...late.slice(0, -2), 'Reading pages, step 2 of 3, 23s, taking longer than usual', 'Ready']
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: true, moments: moments(owned) }), [])
  })

  const long = [...Array(15).fill('Reading pages, step 2 of 3'), 'Ready']
  it('asks for an estimate on a long wait once earlier files have finished', () => {
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: true, moments: moments(long) }), [
      'quiz-1.pdf: no estimate during a 15 s wait',
    ])
  })
  it('does not ask for one before any file has finished, when there is nothing to estimate from', () => {
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: false, moments: moments(long) }), [])
  })
  it('reports a file that never finished', () => {
    assert.deepEqual(estimateProblems({ file: 'quiz-1.pdf', earlierDone: false, moments: moments(['Uploading 10%']) }), [
      'quiz-1.pdf: never finished',
    ])
  })
})
