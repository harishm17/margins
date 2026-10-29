import type { AiStatus } from '@/lib/ai/status'

/** What the Settings page says about today's allowance (from the browser's AI status). */
export type AllowanceView =
  /** A per-user cap: the share used. */
  | { kind: 'used'; percent: number; exhausted: boolean }
  /** No per-user cap, but the service-wide cap is used up. */
  | { kind: 'exhausted' }
  /** No per-user cap. */
  | { kind: 'unlimited' }
  /** No allowance came back (the AI service could not be reached): nothing is known. */
  | { kind: 'unknown' }

export function allowanceView(allowance: AiStatus['allowance']): AllowanceView {
  if (!allowance) return { kind: 'unknown' }
  if (allowance.usedFraction !== null) {
    return { kind: 'used', percent: Math.round(allowance.usedFraction * 100), exhausted: allowance.exhausted }
  }
  return allowance.exhausted ? { kind: 'exhausted' } : { kind: 'unlimited' }
}
