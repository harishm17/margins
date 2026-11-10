/**
 * Handled failures the operator should hear about, recorded for the AI service's watchdog.
 *
 * A failure that is caught and logged where it happens (a stored file that could not be deleted, an account deletion
 * that stopped part way) stays in the log, and nothing reads the log. `recordOpsEvent` also counts it in `ops_events`;
 * the watchdog (ai-service/app/services/watchdog.py) reads that table every few minutes and posts one alert per kind.
 *
 * Recording never throws: the failure it records has already been handled, and must not turn into a second one.
 */

import { logServerError } from '@/lib/ops/log'

export type OpsEventWriter = (kind: string, detail: string | null) => Promise<void>

async function writeToDatabase(kind: string, detail: string | null): Promise<void> {
  const { prisma } = await import('@/lib/db/prisma')
  await prisma.opsEvent.create({ data: { kind, source: 'web', detail } })
}

let writer: OpsEventWriter = writeToDatabase

/** Kinds the web app records. The watchdog alerts on each from its first occurrence. */
export type OpsEventKind = 'storage_delete_failed' | 'account_delete_failed' | 'deletion_record_failed'

export async function recordOpsEvent(kind: OpsEventKind, detail?: string): Promise<void> {
  try {
    await writer(kind, detail ? detail.slice(0, 500) : null)
  } catch (error) {
    logServerError('Ops: could not record an event', error, { kind })
  }
}

/** Tests: record events here instead of in the database (null restores the database). */
export function setOpsEventWriterForTests(replacement: OpsEventWriter | null) {
  writer = replacement ?? writeToDatabase
}
