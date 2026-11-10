import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  formatUsageTables,
  jobUsageFromRow,
  ledgerUsageFromRow,
  summarizeJobs,
  summarizeLedger,
  summarizePurposes,
  visibleShare,
  type JobUsage,
  type LedgerUsage,
} from './table'

const notesRow = (seconds: number, cost: number, cacheRead: number, byPurpose = true) => ({
  job_type: 'generate_content',
  input_data: { topicId: 't', contentType: 'section_notes' },
  seconds,
  llm_cost_usd: cost,
  result_data: {
    sections: [],
    usage: {
      calls: 2,
      models: ['claude-haiku-5-5', 'claude-opus-5-5'],
      estimated_cost_usd: cost,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 100,
      ...(byPurpose
        ? {
            by_purpose: {
              section_notes: { calls: 1, models: ['claude-opus-5-5'], estimated_cost_usd: cost - 0.01, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 100 },
              support_check: { calls: 1, models: ['claude-haiku-5-5'], estimated_cost_usd: 0.01, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
          }
        : {}),
    },
  },
})

describe('a job row', () => {
  it('is named by its type and, for content, the kind of content', () => {
    const job = jobUsageFromRow(notesRow(30, 0.2, 900))
    assert.equal(job.work, 'generate_content: section_notes')
    assert.deepEqual([job.seconds, job.costUsd, job.calls, job.cacheRead, job.cacheWrite], [30, 0.2, 2, 900, 100])
    assert.deepEqual(Object.keys(job.byPurpose ?? {}), ['section_notes', 'support_check'])
    assert.equal(jobUsageFromRow({ job_type: 'validate_material', input_data: {}, seconds: 2, llm_cost_usd: 0, result_data: {} }).work, 'validate_material')
  })

  it('without a usage record costs what its column says, and has no split by purpose', () => {
    const job = jobUsageFromRow({ job_type: 'chunk_material', input_data: null, seconds: null, llm_cost_usd: '0.000000', result_data: null })
    assert.deepEqual([job.seconds, job.costUsd, job.calls, job.cacheRead, job.byPurpose], [null, 0, 0, 0, null])
    assert.equal(jobUsageFromRow(notesRow(30, 0.2, 900, false)).byPurpose, null)
  })
})

describe('the job tables', () => {
  const jobs: JobUsage[] = [notesRow(10, 0.1, 0), notesRow(20, 0.2, 1000), notesRow(30, 0.3, 2000)].map(jobUsageFromRow)

  it('give the median and 90th percentile of time, cost and cache reads per kind of work', () => {
    const [notes] = summarizeJobs(jobs)
    assert.equal(notes.work, 'generate_content: section_notes')
    assert.equal(notes.jobs, 3)
    assert.deepEqual([notes.seconds.p50, notes.seconds.p90], [20, 28])
    assert.deepEqual([notes.costUsd.p50, notes.cacheRead.p50, notes.cacheRead.p90], [0.2, 1000, 1800])
  })

  it('split each kind of work by the purpose of its calls', () => {
    const purposes = summarizePurposes(jobs)
    assert.deepEqual(purposes.map((p) => [p.work, p.purpose, p.jobs, p.calls]), [
      ['generate_content: section_notes', 'section_notes', 3, 3],
      ['generate_content: section_notes', 'support_check', 3, 3],
    ])
    assert.equal(purposes[0].costUsd.p50?.toFixed(2), '0.19')
    assert.deepEqual(purposes[1].models, ['claude-haiku-5-5'])
  })
})

describe('the ledger table', () => {
  const rows: LedgerUsage[] = [
    ledgerUsageFromRow({ source: 'chat', cost_usd: 0.01, output_tokens: 400, cache_read: 0, cache_write: 2000, reply: 'x'.repeat(400) }),
    ledgerUsageFromRow({ source: 'chat', cost_usd: 0.03, output_tokens: 100, cache_read: 2000, cache_write: 0, reply: 'y'.repeat(200) }),
    ledgerUsageFromRow({ source: 'tutor', cost_usd: 0.002, output_tokens: 50, cache_read: null, cache_write: null, reply: null }),
  ]

  it('gives cost and cache per source, and unknown cache where the ledger has no cache columns', () => {
    const [chat, tutor] = summarizeLedger(rows)
    assert.deepEqual([chat.source, chat.rows, chat.costUsd.p50?.toFixed(4), chat.cacheRead.p90], ['chat', 2, '0.0200', 1800])
    assert.deepEqual([tutor.source, tutor.cacheRead.p50, tutor.cacheWrite.p50], ['tutor', null, null])
  })

  it("gives the visible share of Ask's output tokens from the stored replies", () => {
    // 100 of 400 tokens, then 50 of 100 (4 characters a token).
    assert.deepEqual(visibleShare(rows), { replies: 2, median: 0.375, overall: 150 / 500 })
    assert.deepEqual(visibleShare([]), { replies: 0, median: null, overall: null })
  })

  it('counts a token for every 4 characters, rounding up', () => {
    assert.deepEqual([estimateTokens(''), estimateTokens('abc'), estimateTokens('abcde')], [0, 1, 2])
  })
})

describe('the printed tables', () => {
  it('have a row per kind of work, per purpose and per source, with dashes for what is unknown', () => {
    const jobs = [notesRow(10, 0.1, 0)].map(jobUsageFromRow)
    const ledger = [ledgerUsageFromRow({ source: 'voice', cost_usd: 0.001, output_tokens: 10, cache_read: null, cache_write: null, reply: null })]
    const text = formatUsageTables({ jobs, ledger, days: 30 })
    assert.match(text, /\| generate_content: section_notes \| 1 \| 10\.0 \| 10\.0 \| \$0\.1000 \| \$0\.1000 \|/)
    assert.match(text, /\| generate_content: section_notes \| support_check \| 1 \| 1 \|/)
    assert.match(text, /\| voice \| 1 \| \$0\.0010 \| \$0\.0010 \| — \| — \| — \|/)
    assert.match(text, /Visible share of Ask's output tokens: no stored replies/)
    assert.match(text, /Prefetched review items used: not measured/)
  })
})
