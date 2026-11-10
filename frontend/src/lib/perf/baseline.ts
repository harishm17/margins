/**
 * PF0: the speed baseline's figures and tables (printed by scripts/perf-baseline.ts). Lighthouse runs on a phone
 * profile with its simulated throttling; server time is the time to the response headers on the same machine as the
 * server, so it is the page's own work (its queries and rendering), not the network.
 */
import { percentile } from '../voice/turn-timing'

export type LighthouseFigures = {
  /** The performance score out of 100. */
  score: number | null
  fcpMs: number | null
  lcpMs: number | null
  tbtMs: number | null
  cls: number | null
  speedIndexMs: number | null
  /** JavaScript sent, compressed. */
  scriptKb: number | null
  /** Everything sent, compressed. */
  totalKb: number | null
}

export type ServerTimes = { first: number; median: number | null; runs: number }

export type PageFigures = {
  name: string
  path: string
  server: ServerTimes | null
  lighthouse: LighthouseFigures | null
  lighthouseRuns: number
}

export type LiveTiming = { name: string; firstWordsMs: number | null; doneMs: number | null }

export type BundleFigures = { markdownChunkKb: number | null; clientJsKb: number; chunks: number }

type Json = Record<string, unknown>

const objectOf = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const round = (value: number | null, digits = 0): number | null => (value === null ? null : Number(value.toFixed(digits)))
const kb = (bytes: number | null): number | null => round(bytes === null ? null : bytes / 1024, 1)

/** The figures of one Lighthouse result (its JSON report); an audit that is missing is unknown, not zero. */
export function lighthouseFigures(lhr: unknown): LighthouseFigures {
  const report = objectOf(lhr)
  const audits = objectOf(report.audits)
  const value = (name: string) => numberOf(objectOf(audits[name]).numericValue)
  const score = numberOf(objectOf(objectOf(report.categories).performance).score)
  const requests = objectOf(objectOf(audits['network-requests']).details).items
  const scriptBytes = Array.isArray(requests)
    ? requests.reduce((sum: number, item) => sum + (objectOf(item).resourceType === 'Script' ? numberOf(objectOf(item).transferSize) ?? 0 : 0), 0)
    : null
  return {
    score: score === null ? null : Math.round(score * 100),
    fcpMs: round(value('first-contentful-paint')),
    lcpMs: round(value('largest-contentful-paint')),
    tbtMs: round(value('total-blocking-time')),
    cls: round(value('cumulative-layout-shift'), 3),
    speedIndexMs: round(value('speed-index')),
    scriptKb: kb(scriptBytes),
    totalKb: kb(value('total-byte-weight')),
  }
}

/** The median of each figure over several runs of one page. */
export function medianFigures(runs: LighthouseFigures[]): LighthouseFigures {
  const median = (key: keyof LighthouseFigures) => percentile(runs.map((run) => run[key]).filter((v): v is number => v !== null), 50)
  return {
    score: median('score'),
    fcpMs: median('fcpMs'),
    lcpMs: median('lcpMs'),
    tbtMs: median('tbtMs'),
    cls: median('cls'),
    speedIndexMs: median('speedIndexMs'),
    scriptKb: median('scriptKb'),
    totalKb: median('totalKb'),
  }
}

/** The first request of a page is kept apart (caches are cold); the rest give the median. */
export function serverTimes(timesMs: number[]): ServerTimes {
  const [first, ...rest] = timesMs
  return { first, median: percentile(rest, 50), runs: rest.length }
}

/** From the Ask stream's lines with their arrival times: the first text event and the done event, after the request started. */
export function firstWordsMs(startedAt: number, events: { at: number; line: string }[]): { firstWordsMs: number | null; doneMs: number | null } {
  let first: number | null = null
  let done: number | null = null
  for (const { at, line } of events) {
    let type: unknown
    try {
      type = objectOf(JSON.parse(line)).type
    } catch {
      continue
    }
    if (type === 'text' && first === null) first = at - startedAt
    if (type === 'done' && done === null) done = at - startedAt
  }
  return { firstWordsMs: first, doneMs: done }
}

const dash = '—'
const show = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? dash : value.toFixed(digits))
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')

export function formatBaseline({ pages, live, bundle }: { pages: PageFigures[]; live: LiveTiming[]; bundle: BundleFigures | null }): string {
  const lines = [
    '## Pages: server time and Lighthouse (mobile, simulated throttling; medians)',
    '',
    table(
      ['Page', 'Server first (ms)', 'Server median (ms)', 'Score', 'FCP (ms)', 'LCP (ms)', 'TBT (ms)', 'CLS', 'Speed Index (ms)', 'JS (KB)', 'Total (KB)'],
      pages.map((page) => {
        const l = page.lighthouse
        return [
          page.name,
          show(page.server?.first),
          show(page.server?.median),
          show(l?.score),
          show(l?.fcpMs),
          show(l?.lcpMs),
          show(l?.tbtMs),
          show(l?.cls, 3),
          show(l?.speedIndexMs),
          show(l?.scriptKb, 1),
          show(l?.totalKb, 1),
        ]
      })
    ),
    '',
  ]
  if (live.length === 0) lines.push('Ask and tutor: not measured (run with --live; it calls the real model).')
  else lines.push('## Ask and tutor: time to first words (ms)', '', table(['Request', 'First words (ms)', 'Done (ms)'], live.map((t) => [t.name, show(t.firstWordsMs), show(t.doneMs)])))
  if (bundle) {
    lines.push(
      '',
      `Markdown renderer chunk: ${show(bundle.markdownChunkKb, 1)} KB compressed; all ${bundle.chunks} client chunks: ${bundle.clientJsKb.toFixed(1)} KB compressed (gzip).`
    )
  }
  return lines.join('\n')
}
