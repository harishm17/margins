/**
 * The explainer's bookkeeping (spec §5.4).
 * POST /api/topics/[topicId]/explainer { action: 'viewed' }
 *   The explainer was opened: the newest recall attempt of each card is stamped (explainer.viewedAt), which is the
 *   "explainer visit" the next-activity selector reads. Refused (403 EXPLAINER_LOCKED) while the explainer is locked.
 * POST /api/topics/[topicId]/explainer { action: 'gaps_shown' }
 *   The gap explanations were rendered: level 3 on the concepts of the gaps, once per attempt (the AI told the student).
 * POST /api/topics/[topicId]/explainer { action: 'section_viewed', kind: 'gap_explainer' | 'full_explainer', conceptIds?, heading? }
 *   A section scrolled into view: instruction on its concept, one event per concept per local day (spec 18.5). A lesson
 *   section names its concept by its heading.
 * POST /api/topics/[topicId]/explainer { action: 'write' }
 *   "Write them again": starts the gap explanations that were never written (the AI was unavailable, or the job
 *   failed). Answers with the AI's reason when it is unavailable.
 * GET  /api/topics/[topicId]/explainer
 *   The gap explanations and whether they are still being written. 403 EXPLAINER_LOCKED while the explainer is locked.
 * GET  /api/topics/[topicId]/explainer?concept=<conceptId>
 *   The name of that concept of this topic ({ conceptName }, null when it is not one), so the full explainer can scroll to it.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { explainerAccess, explainerViewed, loadGapExplainer, markExplainerViewed, recordGapsShown, startMissingGapExplainers } from '@/lib/learning/explainer-server'
import { ApiErrorCode, apiError, apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('viewed') }),
  z.object({ action: z.literal('gaps_shown') }),
  z.object({ action: z.literal('write') }),
  z.object({
    action: z.literal('section_viewed'),
    kind: z.enum(['gap_explainer', 'full_explainer']),
    conceptIds: z.array(z.string().min(1).max(100)).max(20).optional(),
    heading: z.string().min(1).max(300).optional(),
  }),
])

const locked = () =>
  apiError(ApiErrorCode.FORBIDDEN, 'Try recalling this topic first. The explainer opens after that.', { code: 'EXPLAINER_LOCKED', retryable: false }, 403)

export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const access = await explainerAccess(auth.user.id, topicId)
    if (!access) return apiNotFound('Topic not found')
    if (!access.open) return locked()
    const concept = new URL(request.url).searchParams.get('concept')
    if (concept) {
      const found = await prisma.concept.findFirst({ where: { id: concept, topicId, status: 'active', topic: { project: { userId: auth.user.id } } }, select: { name: true } })
      return NextResponse.json({ conceptName: found?.name ?? null })
    }
    return NextResponse.json(await loadGapExplainer(auth.user.id, topicId))
  } catch (error) {
    console.error('Explainer state error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Could not load the explainer')
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { topicId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const access = await explainerAccess(auth.user.id, topicId)
    if (!access) return apiNotFound('Topic not found')
    if (!access.open) return locked()

    if (parsed.data.action === 'viewed') {
      await markExplainerViewed(auth.user.id, topicId)
      return NextResponse.json({ ok: true })
    }
    if (parsed.data.action === 'gaps_shown') {
      await recordGapsShown({ userId: auth.user.id, topicId, timeZone: await studentTimeZone() })
      return NextResponse.json({ ok: true })
    }
    if (parsed.data.action === 'section_viewed') {
      const written = await explainerViewed(auth.user.id, topicId, { kind: parsed.data.kind, conceptIds: parsed.data.conceptIds, heading: parsed.data.heading, timeZone: await studentTimeZone() })
      return NextResponse.json({ ok: true, recorded: written })
    }
    const started = await startMissingGapExplainers(auth.user.id, topicId)
    if (started.status === 'blocked') {
      return apiError(ApiErrorCode.UPSTREAM_ERROR, 'The explanations cannot be written right now. Try again later.', { code: started.code, retryable: true }, 503)
    }
    if (started.status === 'not_found') return apiNotFound('Answer not found')
    return NextResponse.json({ ok: true, status: started.status })
  } catch (error) {
    console.error('Explainer action error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Could not do that')
  }
}
