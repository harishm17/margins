/**
 * Timing of voice turns (spec §19.10). The turn route logs one line per turn (model calls, time to the first token of each,
 * the time spent in graded steps, the total) and stores the same in voice_turn_timings, with the browser's own numbers for
 * that turn when they arrive (they come with the next turn). `summarizeTimings` gives the P50 and P95 per style;
 * `scripts/voice-timing.ts` prints it. Nothing here holds what anyone said.
 */
import { logServerError } from '@/lib/ops/log'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { VoiceTurnExtras } from '@/lib/voice/turn-contract'
import type { CallTiming } from '@/lib/voice/turn-engine'

const ms = z.number().finite().nonnegative().max(600_000).optional()

/** What the browser sends as `timing` with a turn: each field optional, bounded, and anything else dropped. */
export const clientTimingSchema = z
  .object({
    endpointWaitMs: ms,
    requestToFirstEventMs: ms,
    requestToFirstSentenceMs: ms,
    requestToFirstAudioMs: ms,
    interrupted: z.boolean().optional(),
    recognizer: z.enum(['cloud', 'device', 'browser']).optional(),
  })
  .strip()

// A compile-time check that the schema keeps to the shared contract.
type SchemaFits = z.infer<typeof clientTimingSchema> extends NonNullable<VoiceTurnExtras['timing']> ? true : never
export const SCHEMA_FITS_CONTRACT: SchemaFits = true

export type TurnTimingRow = {
  sessionId: string
  userId: string
  turn: number
  style: string
  preRun: string | null
  graded: boolean
  calls: CallTiming[]
  stepMs: number
  firstTextMs: number | null
  totalMs: number
  ok: boolean
}

/** The line the route logs for a turn. */
export function timingLogLine(row: TurnTimingRow): string {
  return `[VOICE] timing ${JSON.stringify({
    session: row.sessionId,
    turn: row.turn,
    style: row.style,
    ok: row.ok,
    graded: row.graded,
    preRun: row.preRun,
    modelCalls: row.calls.length,
    ttftMs: row.calls.map((call) => call.ttftMs),
    stepMs: row.stepMs,
    firstTextMs: row.firstTextMs,
    totalMs: row.totalMs,
  })}`
}

/** Logs the turn and stores it. A failure to store is logged and never touches the turn. */
export async function recordTurnTiming(row: TurnTimingRow, log: (line: string) => void = console.log): Promise<void> {
  log(timingLogLine(row))
  try {
    await prisma.voiceTurnTiming.upsert({
      where: { sessionId_turn: { sessionId: row.sessionId, turn: row.turn } },
      create: {
        sessionId: row.sessionId,
        userId: row.userId,
        turn: row.turn,
        style: row.style,
        preRun: row.preRun,
        graded: row.graded,
        modelCalls: row.calls.length,
        ttftMs: row.calls.map((call) => call.ttftMs) as unknown as Prisma.InputJsonValue,
        stepMs: Math.round(row.stepMs),
        firstTextMs: row.firstTextMs === null ? null : Math.round(row.firstTextMs),
        totalMs: Math.round(row.totalMs),
        ok: row.ok,
      },
      update: {},
    })
  } catch (error) {
    logServerError('Voice: Could not store the turn timing', error)
  }
}

/** Stores the browser's timings for the turn before this one (the client measures a turn through its first audio, after the reply is over). */
export async function attachClientTiming(sessionId: string, thisTurn: number, client: NonNullable<VoiceTurnExtras['timing']>): Promise<void> {
  if (Object.keys(client).length === 0) return
  try {
    await prisma.voiceTurnTiming.updateMany({ where: { sessionId, turn: thisTurn - 1 }, data: { client: client as unknown as Prisma.InputJsonValue } })
  } catch (error) {
    logServerError('Voice: Could not store the browser timing', error)
  }
}

// ---------------------------------------------------------------------------------------------- P50 and P95

/** The p-th percentile (0 to 100) by linear interpolation; null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

export type StoredTiming = {
  style: string
  graded: boolean
  ok: boolean
  modelCalls: number
  ttftMs: unknown
  stepMs: number
  firstTextMs: number | null
  totalMs: number
  client: unknown
}

export type Spread = { p50: number | null; p95: number | null }
export type ModeSummary = {
  style: string
  graded: boolean
  turns: number
  modelCalls: number
  ttft: Spread
  step: Spread
  firstText: Spread
  total: Spread
  /** The browser's request-to-first-sentence, for turns that have it. */
  clientFirstSentence: Spread & { n: number }
}

const spread = (values: number[]): Spread => ({ p50: percentile(values, 50), p95: percentile(values, 95) })
const numbers = (values: unknown[]): number[] => values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

/** Per style, and graded turns apart from the rest: how many turns, mean model calls, and P50 and P95 of each time. Failed turns are left out. */
export function summarizeTimings(rows: StoredTiming[]): ModeSummary[] {
  const groups = new Map<string, StoredTiming[]>()
  for (const row of rows) {
    if (!row.ok) continue
    const key = `${row.style}|${row.graded}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()]
    .map(([key, group]): ModeSummary => {
      const [style, graded] = key.split('|')
      const client = numbers(group.map((row) => (row.client as { requestToFirstSentenceMs?: unknown } | null)?.requestToFirstSentenceMs))
      return {
        style,
        graded: graded === 'true',
        turns: group.length,
        modelCalls: group.reduce((sum, row) => sum + row.modelCalls, 0) / group.length,
        ttft: spread(numbers(group.flatMap((row) => (Array.isArray(row.ttftMs) ? row.ttftMs : [])))),
        step: spread(group.map((row) => row.stepMs)),
        firstText: spread(numbers(group.map((row) => row.firstTextMs))),
        total: spread(group.map((row) => row.totalMs)),
        clientFirstSentence: { ...spread(client), n: client.length },
      }
    })
    .sort((a, b) => a.style.localeCompare(b.style) || Number(b.graded) - Number(a.graded))
}

const secs = (value: number | null) => (value === null ? '-' : (value / 1000).toFixed(2))

/** A table of the summaries, in seconds. */
export function formatSummary(summaries: ModeSummary[]): string {
  if (summaries.length === 0) return 'No voice turns recorded.'
  const head = ['mode', 'graded', 'turns', 'calls', 'ttft p50', 'ttft p95', 'step p50', 'step p95', '1st text p50', '1st text p95', 'total p50', 'total p95', 'browser 1st sentence p50/p95 (n)']
  const rows = summaries.map((s) => [
    s.style,
    s.graded ? 'yes' : 'no',
    String(s.turns),
    s.modelCalls.toFixed(2),
    secs(s.ttft.p50),
    secs(s.ttft.p95),
    secs(s.step.p50),
    secs(s.step.p95),
    secs(s.firstText.p50),
    secs(s.firstText.p95),
    secs(s.total.p50),
    secs(s.total.p95),
    `${secs(s.clientFirstSentence.p50)}/${secs(s.clientFirstSentence.p95)} (${s.clientFirstSentence.n})`,
  ])
  const widths = head.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)))
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
  return ['Seconds. ttft = time to the first token of a model call; step = time in graded steps; 1st text = request to first text on the server.', line(head), ...rows.map(line)].join('\n')
}
