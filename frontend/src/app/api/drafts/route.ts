/**
 * Server-side drafts (spec §18.7), the one store every writing surface uses.
 * Surface, key and payload shapes: lib/drafts/draft-contract.ts. Behaviour: lib/drafts/draft-store.ts.
 * The browser side is features/learning/use-server-draft.ts.
 *
 * GET    /api/drafts?surface=&key=
 *   200 { draft: { payload, version, updatedAt, expiresAt } | null }
 * PUT    /api/drafts?surface=&key=   body { payload, version, projectId, topicId? }
 *   `version` is the one the client last saw, 0 when it believes there is no draft.
 *   200 { draft }                                          saved; keep draft.version for the next write
 *   409 { error: { code: 'CONFLICT', details: { code: 'STALE_VERSION', draft } } }
 *       another tab or device wrote first; `draft` is the stored one, or null when it is gone
 *   409 { error: { code: 'CONFLICT', details: { code: 'RETRY_TOMORROW', opensAt } } }
 *       a new quiz draft for a set taken today (the student's zone)
 *   400 invalid shape, key or version; 413 over 16 KB; 404 project, topic or quiz set not yours / not found;
 *   400 TOO_MANY_DRAFTS past 500 live drafts; 429 rate limit (120 a minute per user)
 * DELETE /api/drafts?surface=&key=
 *   200 { ok: true }, also when there was nothing to delete
 * A user only ever reaches their own drafts: every query filters on the signed-in user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { clearDraft, loadDraft, saveDraft, type StoredDraft } from '@/lib/drafts/draft-store'
import { isDraftSurface, MAX_DRAFT_BYTES, parseDraftKey, type DraftSurface, type DraftWire } from '@/lib/drafts/draft-contract'
import { ApiErrorCode, apiError, apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError, zodDetails } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const limiter = createRateLimiter({ limit: 120, windowMs: 60_000 })

/** A request body may carry a payload of the cap plus its frame; anything past this is not read further. */
const MAX_BODY_CHARS = MAX_DRAFT_BYTES * 2 + 1024

const putSchema = z.object({
  payload: z.unknown(),
  version: z.number().int().min(0),
  projectId: z.string().min(1).max(100),
  topicId: z.string().min(1).max(100).nullish(),
})

const wire = (draft: StoredDraft): DraftWire => ({
  payload: draft.payload,
  version: draft.version,
  updatedAt: draft.updatedAt.toISOString(),
  expiresAt: draft.expiresAt.toISOString(),
})

function target(request: NextRequest): { surface: DraftSurface; key: string } | null {
  const surface = request.nextUrl.searchParams.get('surface')
  const key = request.nextUrl.searchParams.get('key')
  if (!isDraftSurface(surface) || !key || !parseDraftKey(surface, key)) return null
  return { surface, key }
}

function rateLimited(userId: string) {
  const rate = limiter.check(userId)
  if (rate.ok) return null
  const response = apiError(ApiErrorCode.RATE_LIMITED, 'Saving is going too fast. Wait a moment.', { code: 'RATE_LIMITED', retryable: true }, 429)
  response.headers.set('Retry-After', String(rate.retryAfterSeconds))
  return response
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const slot = target(request)
    if (!slot) return apiInvalidInput('Invalid surface or key')
    const limited = rateLimited(auth.user.id)
    if (limited) return limited
    const draft = await loadDraft(auth.user.id, slot.surface, slot.key)
    return NextResponse.json({ draft: draft ? wire(draft) : null })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Draft load error:', error)
    return apiInternal('Could not load the draft')
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const slot = target(request)
    if (!slot) return apiInvalidInput('Invalid surface or key')
    const limited = rateLimited(auth.user.id)
    if (limited) return limited

    const text = await request.text()
    if (text.length > MAX_BODY_CHARS) return apiError(ApiErrorCode.INVALID_INPUT, 'Draft is too large', { code: 'PAYLOAD_TOO_LARGE' }, 413)
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const parsed = putSchema.safeParse(body)
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))

    const result = await saveDraft(
      auth.user.id,
      { ...slot, projectId: parsed.data.projectId, topicId: parsed.data.topicId ?? null, payload: parsed.data.payload, version: parsed.data.version },
      { timeZone: await studentTimeZone() }
    )
    switch (result.status) {
      case 'saved':
        return NextResponse.json({ draft: wire(result.draft) })
      case 'conflict':
        return apiError(ApiErrorCode.CONFLICT, 'This draft changed somewhere else.', { code: 'STALE_VERSION', draft: result.draft ? wire(result.draft) : null }, 409)
      case 'retry_tomorrow':
        return apiError(ApiErrorCode.CONFLICT, 'This quiz was taken today.', { code: 'RETRY_TOMORROW', opensAt: result.opensAt.toISOString() }, 409)
      case 'not_found':
        return apiNotFound('Nothing to save a draft for')
      case 'invalid':
        return apiInvalidInput(result.message)
      case 'too_large':
        return apiError(ApiErrorCode.INVALID_INPUT, result.message, { code: 'PAYLOAD_TOO_LARGE' }, 413)
      case 'too_many':
        return apiError(ApiErrorCode.INVALID_INPUT, 'Too many unfinished drafts. Finish or discard some.', { code: 'TOO_MANY_DRAFTS' }, 400)
    }
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Draft save error:', error)
    return apiInternal('Could not save the draft')
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const slot = target(request)
    if (!slot) return apiInvalidInput('Invalid surface or key')
    const limited = rateLimited(auth.user.id)
    if (limited) return limited
    await clearDraft(auth.user.id, slot.surface, slot.key)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Draft delete error:', error)
    return apiInternal('Could not delete the draft')
  }
}
