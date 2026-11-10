'use server'

import { logServerError } from '@/lib/ops/log'
import { revalidatePath } from 'next/cache'
import { setQuickPass } from '@/lib/learning/short-session-server'
import { getSessionUser } from '@/server/session'

export type QuickPassResult = { ok: true } | { ok: false; error: 'signed_out' | 'not_found' | 'failed' }

/**
 * "Quick pass" and "Undo quick pass" on the plan (spec 18.8): sets or clears `TopicProgress.triage` for one of the signed-in
 * student's topics, and draws the plan again with the topic's 20-minute block (or its full one). Home, the overview and the topic
 * page read the same field, so they follow.
 */
export async function setQuickPassAction(courseId: string, topicId: string, quick: boolean): Promise<QuickPassResult> {
  const user = await getSessionUser()
  if (!user) return { ok: false, error: 'signed_out' }
  if (typeof courseId !== 'string' || typeof topicId !== 'string') return { ok: false, error: 'not_found' }
  try {
    if ((await setQuickPass(user.id, topicId, quick === true)) === 'not_found') return { ok: false, error: 'not_found' }
  } catch (error) {
    logServerError('Plan: setting a quick pass failed', error, { topicId })
    return { ok: false, error: 'failed' }
  }
  revalidatePath(`/courses/${courseId}/plan`)
  revalidatePath(`/courses/${courseId}`)
  revalidatePath('/home')
  return { ok: true }
}
