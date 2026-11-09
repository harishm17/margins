import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { firstWordsMs, formatBaseline, lighthouseFigures, medianFigures, serverTimes, type PageFigures } from './baseline'

const lhr = (score: number, lcp: number, scripts: number[]) => ({
  categories: { performance: { score } },
  audits: {
    'first-contentful-paint': { numericValue: 900 },
    'largest-contentful-paint': { numericValue: lcp },
    'total-blocking-time': { numericValue: 120 },
    'cumulative-layout-shift': { numericValue: 0.02 },
    'speed-index': { numericValue: 1500 },
    'total-byte-weight': { numericValue: 400_000 },
    'network-requests': {
      details: {
        items: [
          ...scripts.map((bytes) => ({ resourceType: 'Script', transferSize: bytes })),
          { resourceType: 'Stylesheet', transferSize: 9_000 },
        ],
      },
    },
  },
})

describe('a Lighthouse run', () => {
  it('gives the score out of 100, the paint and blocking times, and the JavaScript sent', () => {
    assert.deepEqual(lighthouseFigures(lhr(0.71, 3200, [100_000, 50_000])), {
      score: 71,
      fcpMs: 900,
      lcpMs: 3200,
      tbtMs: 120,
      cls: 0.02,
      speedIndexMs: 1500,
      scriptKb: 146.5,
      totalKb: 390.6,
    })
  })

  it('reads a missing audit as unknown, not as zero', () => {
    const figures = lighthouseFigures({ categories: { performance: { score: null } }, audits: {} })
    assert.deepEqual([figures.score, figures.lcpMs, figures.scriptKb], [null, null, null])
  })
})

describe('several runs of a page', () => {
  it('give the median of each figure', () => {
    const runs = [lhr(0.6, 4000, [1024]), lhr(0.8, 2000, [1024]), lhr(0.7, 3000, [2048])].map(lighthouseFigures)
    const median = medianFigures(runs)
    assert.deepEqual([median.score, median.lcpMs, median.scriptKb], [70, 3000, 1])
  })
})

describe('server time', () => {
  it('keeps the first request apart and gives the median of the rest', () => {
    assert.deepEqual(serverTimes([900, 120, 100, 140]), { first: 900, median: 120, runs: 3 })
    assert.deepEqual(serverTimes([300]), { first: 300, median: null, runs: 0 })
  })
})

describe('time to first words', () => {
  it('is the arrival of the first text event, after the start of the request', () => {
    const events = [
      { at: 1100, line: '{"type":"thread","threadId":"t","title":null,"isNew":true}' },
      { at: 1900, line: '{"type":"progress","stage":"writing"}' },
      { at: 2600, line: '{"type":"text","delta":"The"}' },
      { at: 4000, line: '{"type":"done"}' },
    ]
    assert.deepEqual(firstWordsMs(1000, events), { firstWordsMs: 1600, doneMs: 3000 })
  })

  it('is unknown when no text came', () => {
    assert.deepEqual(firstWordsMs(0, [{ at: 50, line: '{"type":"error","code":"X"}' }, { at: 60, line: 'not json' }]), { firstWordsMs: null, doneMs: null })
  })
})

describe('the baseline tables', () => {
  it('have a row per page with server time and the Lighthouse medians, and dashes for what was not measured', () => {
    const page: PageFigures = {
      name: 'Topic Read',
      path: '/courses/c/topics/t',
      server: { first: 812.4, median: 143.2, runs: 4 },
      lighthouse: medianFigures([lighthouseFigures(lhr(0.71, 3200, [100_000]))]),
      lighthouseRuns: 1,
    }
    const text = formatBaseline({ pages: [page, { ...page, name: 'Ask', lighthouse: null, lighthouseRuns: 0 }], live: [], bundle: null })
    assert.match(text, /\| Topic Read \| 812 \| 143 \| 71 \| 900 \| 3200 \| 120 \| 0\.020 \| 1500 \| 97\.7 \| 390\.6 \|/)
    assert.match(text, /\| Ask \| 812 \| 143 \| — \| — \| — \| — \| — \| — \| — \| — \|/)
    assert.match(text, /Ask and tutor: not measured/)
  })

  it('list the live timings and the reading bundle when they were measured', () => {
    const text = formatBaseline({
      pages: [],
      live: [{ name: 'Ask, question 1', firstWordsMs: 2400, doneMs: 9100 }],
      bundle: { markdownChunkKb: 184.2, clientJsKb: 1160.5, chunks: 124 },
    })
    assert.match(text, /\| Ask, question 1 \| 2400 \| 9100 \|/)
    assert.match(text, /Markdown renderer chunk: 184\.2 KB compressed; all 124 client chunks: 1160\.5 KB compressed/)
  })
})
