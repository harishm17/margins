/**
 * Whether AI features can be used right now, as the browser and the server share it.
 *
 * The AI service keeps the real record (GET /status/ai): a provider failure such as running out
 * of credit marks AI unavailable for everyone, and the next successful call clears it. The server
 * reads it through getAiStatus (src/server/ai-status.ts); the browser through useAiStatus
 * (features/ai/ai-status.tsx), which asks /api/ai-status. Pure: no fetch, no React.
 */

/** The allowance as the server sees it. `used` and `limit` are dollars and never reach a page. */
export type AiAllowanceDetails = {
  used: number
  /** Null when there is no per-user cap. */
  limit: number | null
  resetsAt: string
  /** used / limit, 0 to 1, or null without a cap. */
  usedFraction: number | null
  exhausted: boolean
}

export type AiStatusDetails = {
  available: boolean
  /** The code that made AI unavailable (LLM_CREDIT_EXHAUSTED, AI_UNREACHABLE, ...), or null. */
  reason: string | null
  /** When it became unavailable. */
  since: string | null
  /** Every user together has used the day's cap. */
  globalCapHit: boolean
  /** Null when no user was given. */
  allowance: AiAllowanceDetails | null
  resetsAt: string
}

/** What the browser gets: no dollar figures. */
export type AiStatus = {
  available: boolean
  reason: string | null
  since: string | null
  /** Why AI actions are refused for this student right now: the reason, LLM_DAILY_BUDGET, or null. */
  blocked: string | null
  allowance: { usedFraction: number | null; exhausted: boolean; resetsAt: string } | null
}

export const AVAILABLE: AiStatus = { available: true, reason: null, since: null, blocked: null, allowance: null }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The next midnight UTC, the allowance reset, when the service did not say. */
const nextMidnightUtc = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()

/** The AI service's answer, checked field by field. Anything malformed reads as available. */
export function parseStatusResponse(body: unknown, now: Date = new Date()): AiStatusDetails {
  const data = isRecord(body) ? body : {}
  const resetsAt = str(data.resets_at) ?? nextMidnightUtc(now)
  const available = data.available !== false
  let allowance: AiAllowanceDetails | null = null
  if (isRecord(data.allowance)) {
    const used = Math.max(0, num(data.allowance.used) ?? 0)
    const limit = num(data.allowance.limit)
    const capped = limit !== null && limit > 0
    allowance = {
      used,
      limit: capped ? limit : null,
      resetsAt: str(data.allowance.resets_at) ?? resetsAt,
      usedFraction: capped ? Math.min(1, used / limit) : null,
      exhausted: capped ? used >= limit : false,
    }
  }
  return {
    available,
    reason: available ? null : (str(data.reason) ?? 'AI_UNREACHABLE'),
    since: available ? null : str(data.since),
    globalCapHit: data.global_cap_hit === true,
    allowance,
    resetsAt,
  }
}

/** Unavailable because the AI service itself could not be reached. */
export function unreachableStatus(now: Date = new Date()): AiStatusDetails {
  return {
    available: false,
    reason: 'AI_UNREACHABLE',
    since: null,
    globalCapHit: false,
    allowance: null,
    resetsAt: nextMidnightUtc(now),
  }
}

/** Why an AI action would be refused now, or null when it may start. */
export function blockedCode(status: AiStatusDetails): string | null {
  if (!status.available) return status.reason ?? 'AI_UNREACHABLE'
  if (status.globalCapHit || status.allowance?.exhausted) return 'LLM_DAILY_BUDGET'
  return null
}

/** The browser's copy of a status. */
export function toClientStatus(status: AiStatusDetails): AiStatus {
  return {
    available: status.available,
    reason: status.reason,
    since: status.since,
    blocked: blockedCode(status),
    allowance: status.allowance
      ? {
          usedFraction: status.allowance.usedFraction,
          exhausted: status.allowance.exhausted || status.globalCapHit,
          resetsAt: status.allowance.resetsAt,
        }
      : null,
  }
}
