import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { aiMessage } from '../../../src/lib/ai/messages'
import { markAiAvailable } from '../../e2e/helpers/db'

/** The provider errors a workflow can stage: the replay provider fails every model call with one (LLM_REPLAY_FAULT_FILE). */
export type FaultCode = 'LLM_UNAVAILABLE' | 'LLM_RATE_LIMITED' | 'LLM_CREDIT_EXHAUSTED' | 'LLM_AUTH_FAILED'

/** The file scripts/e2e-stack.sh points the AI service at; a code in it is an outage, an empty file is none. */
function faultFile(): string {
  const dir = process.env.E2E_RUN_DIR
  if (!dir) throw new Error("Set E2E_RUN_DIR to the stack's run folder (scripts/e2e-stack.sh)")
  return path.join(dir, 'llm-fault')
}

/** Every model call fails with `code` from now on, as the provider's would after its own retries. */
export function stageOutage(code: FaultCode): void {
  writeFileSync(faultFile(), code)
}

/** The provider answers again. The shared status may still say "unavailable": see `statusRecovered`. */
export function endOutage(): void {
  writeFileSync(faultFile(), '')
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The shared messages a surface may show while the provider fails with `code` (lib/ai/messages.ts): the code's own,
 * and "paused" once the failures have repeated and the shared AI status has turned.
 */
function sharedMessages(code: FaultCode): string[] {
  return [aiMessage(code).text, aiMessage('LLM_CREDIT_EXHAUSTED').text].map(oneLine)
}

/** What a surface showed once its AI call failed. */
export type FailedSurface = { text: string; retryShown: boolean; draftKept: boolean }

/** WF11: what a failed surface leaves out of the shared error state: the shared message, a way to try again, the draft. */
export function errorStateGaps(seen: FailedSurface, code: FaultCode): string[] {
  const text = oneLine(seen.text)
  return [
    ...(sharedMessages(code).some((message) => text.includes(message)) ? [] : ['the shared message']),
    ...(seen.retryShown ? [] : ['a way to try again']),
    ...(seen.draftKept ? [] : ["the student's draft"]),
  ]
}

/** Whether `text` shows one of the shared messages for `code` yet. */
export function showsSharedMessage(text: string, code: FaultCode): boolean {
  return sharedMessages(code).some((message) => oneLine(text).includes(message))
}

/**
 * Once the outage has ended, waits until the app says the AI can be used again. An "unavailable" status is trusted for
 * 5 minutes (AI_STATUS_TTL_S) before the next call tests the provider; the row is cleared instead, as the e2e specs do,
 * standing in for those minutes.
 */
export async function statusRecovered(page: Page): Promise<void> {
  await markAiAvailable()
  await expect
    .poll(async () => ((await (await page.request.get('/api/ai-status')).json()) as { available: boolean }).available, {
      timeout: 2 * 60_000,
      intervals: [2000],
    })
    .toBe(true)
}
