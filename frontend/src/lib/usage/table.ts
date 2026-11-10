/**
 * A4: time, cost and prompt-cache use per kind of work, the tables D1, S2, M4 to M7, X2 and X4 take their figures from.
 * Jobs are read from their own rows (`processing_jobs.result_data.usage`, split by call purpose since A4); Ask, the
 * tutors, grading and voice from the spend ledger (`llm_usage_events`, with cache columns since A4). Printed by
 * scripts/usage-table.ts.
 */
import { percentile } from '../voice/turn-timing'

export type PurposeUsage = { calls: number; models: string[]; costUsd: number | null; cacheRead: number; cacheWrite: number }

export type JobUsage = {
  /** The job type, and for a content job the kind of content ("generate_content: section_notes"). */
  work: string
  seconds: number | null
  costUsd: number | null
  calls: number
  cacheRead: number
  cacheWrite: number
  /** Per call purpose; null on a row written before the split. */
  byPurpose: Record<string, PurposeUsage> | null
}

export type LedgerUsage = {
  source: string
  costUsd: number
  outputTokens: number
  /** Null on a database from before the ledger had cache columns. */
  cacheRead: number | null
  cacheWrite: number | null
  /** The stored answer, for an Ask row joined to it. */
  reply: string | null
}

type Json = Record<string, unknown>
type Spread = { p50: number | null; p90: number | null }

const objectOf = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null)
const numberOf = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const spread = (values: (number | null)[]): Spread => {
  const known = values.filter((v): v is number => v !== null)
  return { p50: percentile(known, 50), p90: percentile(known, 90) }
}

function purposeOf(raw: Json): PurposeUsage {
  return {
    calls: numberOf(raw.calls) ?? 0,
    models: stringsOf(raw.models),
    costUsd: numberOf(raw.estimated_cost_usd),
    cacheRead: numberOf(raw.cache_read_input_tokens) ?? 0,
    cacheWrite: numberOf(raw.cache_creation_input_tokens) ?? 0,
  }
}

/** One completed job, as read from `processing_jobs` (its cost from the usage record, else from its cost column). */
export function jobUsageFromRow(row: { job_type: string; input_data: unknown; seconds: unknown; llm_cost_usd: unknown; result_data: unknown }): JobUsage {
  const contentType = objectOf(row.input_data)?.contentType
  const usage = objectOf(objectOf(row.result_data)?.usage)
  const byPurpose = objectOf(usage?.by_purpose)
  const totals = usage ? purposeOf(usage) : null
  return {
    work: typeof contentType === 'string' ? `${row.job_type}: ${contentType}` : row.job_type,
    seconds: numberOf(row.seconds),
    costUsd: totals?.costUsd ?? numberOf(row.llm_cost_usd),
    calls: totals?.calls ?? 0,
    cacheRead: totals?.cacheRead ?? 0,
    cacheWrite: totals?.cacheWrite ?? 0,
    byPurpose: byPurpose
      ? Object.fromEntries(Object.entries(byPurpose).flatMap(([name, raw]) => (objectOf(raw) ? [[name, purposeOf(objectOf(raw)!)]] : [])))
      : null,
  }
}

/** One ledger row other than a job's, with the Ask answer it paid for when there is one. */
export function ledgerUsageFromRow(row: { source: string; cost_usd: unknown; output_tokens: unknown; cache_read: unknown; cache_write: unknown; reply: unknown }): LedgerUsage {
  return {
    source: row.source,
    costUsd: numberOf(row.cost_usd) ?? 0,
    outputTokens: numberOf(row.output_tokens) ?? 0,
    cacheRead: numberOf(row.cache_read),
    cacheWrite: numberOf(row.cache_write),
    reply: typeof row.reply === 'string' ? row.reply : null,
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function summarizeJobs(jobs: JobUsage[]) {
  return groupBy(jobs, (job) => job.work).map(([work, group]) => ({
    work,
    jobs: group.length,
    seconds: spread(group.map((job) => job.seconds)),
    costUsd: spread(group.map((job) => job.costUsd)),
    cacheRead: spread(group.map((job) => job.cacheRead)),
    cacheWrite: spread(group.map((job) => job.cacheWrite)),
    calls: spread(group.map((job) => job.calls)),
  }))
}

/** Per kind of work and call purpose, over the jobs that have the split: calls, and cost and cache reads per job. */
export function summarizePurposes(jobs: JobUsage[]) {
  const calls = jobs.flatMap((job) => Object.entries(job.byPurpose ?? {}).map(([purpose, usage]) => ({ work: job.work, purpose, usage })))
  return groupBy(calls, (call) => `${call.work}\u0000${call.purpose}`).map(([, group]) => ({
    work: group[0].work,
    purpose: group[0].purpose,
    jobs: group.length,
    calls: group.reduce((sum, call) => sum + call.usage.calls, 0),
    models: [...new Set(group.flatMap((call) => call.usage.models))].sort(),
    costUsd: spread(group.map((call) => call.usage.costUsd)),
    cacheRead: spread(group.map((call) => call.usage.cacheRead)),
    cacheWrite: spread(group.map((call) => call.usage.cacheWrite)),
  }))
}

export function summarizeLedger(rows: LedgerUsage[]) {
  return groupBy(rows, (row) => row.source).map(([source, group]) => ({
    source,
    rows: group.length,
    costUsd: spread(group.map((row) => row.costUsd)),
    cacheRead: spread(group.map((row) => row.cacheRead)),
    cacheWrite: spread(group.map((row) => row.cacheWrite)),
  }))
}

/** Tokens in a stored text, estimated at 4 characters a token (no tokenizer runs here; the share is a rough figure). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * How much of what Ask's model calls wrote reached the student: the stored answer's tokens over the output tokens its
 * ledger row paid for (thinking, the router and the checks are the rest). The median per answer, and over all answers.
 */
export function visibleShare(rows: LedgerUsage[]): { replies: number; median: number | null; overall: number | null } {
  const answered = rows.filter((row) => row.source === 'chat' && row.reply !== null && row.outputTokens > 0)
  if (answered.length === 0) return { replies: 0, median: null, overall: null }
  const visible = answered.map((row) => Math.min(estimateTokens(row.reply!), row.outputTokens))
  const paid = answered.map((row) => row.outputTokens)
  return {
    replies: answered.length,
    median: percentile(visible.map((tokens, i) => tokens / paid[i]), 50),
    overall: visible.reduce((a, b) => a + b, 0) / paid.reduce((a, b) => a + b, 0),
  }
}

const dash = '—'
const seconds = (v: number | null) => (v === null ? dash : v.toFixed(1))
const usd = (v: number | null) => (v === null ? dash : `$${v.toFixed(4)}`)
const tokens = (v: number | null) => (v === null ? dash : String(Math.round(v)))
const percent = (v: number | null) => (v === null ? dash : `${Math.round(v * 100)}%`)
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')

export function formatUsageTables({ jobs, ledger, days }: { jobs: JobUsage[]; ledger: LedgerUsage[]; days: number }): string {
  const share = visibleShare(ledger)
  const split = jobs.filter((job) => job.byPurpose !== null).length
  return [
    `## Jobs (completed, last ${days} days): time, cost and cache per job`,
    '',
    table(
      ['Work', 'Jobs', 'Seconds p50', 'Seconds p90', 'Cost p50', 'Cost p90', 'Cache read p50', 'Cache read p90', 'Cache write p50', 'Calls p50'],
      summarizeJobs(jobs).map((s) => [s.work, String(s.jobs), seconds(s.seconds.p50), seconds(s.seconds.p90), usd(s.costUsd.p50), usd(s.costUsd.p90), tokens(s.cacheRead.p50), tokens(s.cacheRead.p90), tokens(s.cacheWrite.p50), tokens(s.calls.p50)])
    ),
    '',
    `## Calls inside jobs, by purpose (${split} of ${jobs.length} jobs record the split): cost and cache per job`,
    '',
    table(
      ['Work', 'Purpose', 'Jobs', 'Calls', 'Models', 'Cost p50', 'Cost p90', 'Cache read p50', 'Cache read p90', 'Cache write p50'],
      summarizePurposes(jobs).map((s) => [s.work, s.purpose, String(s.jobs), String(s.calls), s.models.join(', '), usd(s.costUsd.p50), usd(s.costUsd.p90), tokens(s.cacheRead.p50), tokens(s.cacheRead.p90), tokens(s.cacheWrite.p50)])
    ),
    '',
    `## Ask, tutors, grading and voice (ledger rows, last ${days} days): cost and cache per row`,
    '',
    table(
      ['Source', 'Rows', 'Cost p50', 'Cost p90', 'Cache read p50', 'Cache read p90', 'Cache write p50'],
      summarizeLedger(ledger).map((s) => [s.source, String(s.rows), usd(s.costUsd.p50), usd(s.costUsd.p90), tokens(s.cacheRead.p50), tokens(s.cacheRead.p90), tokens(s.cacheWrite.p50)])
    ),
    '',
    share.replies === 0
      ? "Visible share of Ask's output tokens: no stored replies."
      : `Visible share of Ask's output tokens (stored answer at 4 characters a token, over the row's output): median ${percent(share.median)}, overall ${percent(share.overall)}, over ${share.replies} answers.`,
    'Prefetched review items used: not measured (nothing is prefetched until S3, which marks the items it prefetches).',
  ].join('\n')
}
