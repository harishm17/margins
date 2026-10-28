/**
 * GET /api/ai-status: whether AI features can be used now, for the banner and the AI buttons.
 * Public (the marketing and sign-in pages show the banner too); a signed-in student also gets
 * their allowance, as a share of the day's limit, never in dollars.
 */
import { NextResponse } from 'next/server'
import { toClientStatus } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { getSessionUser } from '@/server/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getSessionUser().catch(() => null)
  const status = toClientStatus(await getAiStatus(user?.id ?? null))
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } })
}
