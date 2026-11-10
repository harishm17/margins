import assert from 'node:assert/strict'
import test from 'node:test'
import { clientTimingSchema, formatSummary, percentile, summarizeTimings, type StoredTiming } from './turn-timing'

const row = (extra: Partial<StoredTiming>): StoredTiming => ({ style: 'teach_back', graded: true, ok: true, modelCalls: 1, ttftMs: [1000], stepMs: 500, firstTextMs: 1700, totalMs: 2500, client: null, ...extra })

test('percentiles interpolate and handle no values', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 95), 7)
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([10, 20, 30, 40], 50), 25)
  assert.equal(percentile([0, 100], 95), 95)
})

test('the summary groups by style and graded, leaves out failed turns, and reads the browser numbers when there are some', () => {
  const rows = [
    row({ firstTextMs: 1500, client: { requestToFirstSentenceMs: 1800 } }),
    row({ firstTextMs: 2500, modelCalls: 2, ttftMs: [1100, 900], client: { requestToFirstSentenceMs: 2800 } }),
    row({ ok: false, firstTextMs: 99_000 }),
    row({ graded: false, style: 'oral_quiz', firstTextMs: 1200, stepMs: 0 }),
  ]
  const [quiz, teach] = summarizeTimings(rows)
  assert.equal(quiz.style, 'oral_quiz')
  assert.equal(quiz.graded, false)
  assert.equal(teach.turns, 2)
  assert.equal(teach.modelCalls, 1.5)
  assert.equal(teach.firstText.p50, 2000)
  assert.equal(teach.ttft.p50, 1000)
  assert.equal(teach.clientFirstSentence.n, 2)
  assert.equal(teach.clientFirstSentence.p50, 2300)
  const text = formatSummary([quiz, teach])
  assert.match(text, /teach_back\s+yes\s+2\s+1\.50/)
  assert.match(formatSummary([]), /No voice turns/)
})

test('the browser timing is bounded and anything else is dropped', () => {
  assert.deepEqual(clientTimingSchema.parse({ endpointWaitMs: 1200, requestToFirstSentenceMs: 1900, interrupted: true, junk: 1 }), { endpointWaitMs: 1200, requestToFirstSentenceMs: 1900, interrupted: true })
  assert.equal(clientTimingSchema.safeParse({ endpointWaitMs: -1 }).success, false)
  assert.equal(clientTimingSchema.safeParse({ endpointWaitMs: 'x' }).success, false)
})
