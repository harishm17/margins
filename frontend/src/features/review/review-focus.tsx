'use client'

import { FocusHeader } from '@/components/shell/slots'
import { AiStatusBanner } from '@/features/ai/ai-status'
import { ReviewSession } from './review-session'

/** The review session screen: the focus layout's bar with the course name, then one 720px column. */
export function ReviewFocus({
  courseId,
  courseName,
  topicId,
  conceptId,
  sessionId,
}: {
  courseId: string
  courseName: string
  topicId?: string
  conceptId?: string
  sessionId?: string
}) {
  return (
    <>
      <FocusHeader title={courseName} />
      <AiStatusBanner />
      <div className="mx-auto min-h-[calc(100dvh-var(--topbar-height))] w-full max-w-[720px] px-4 pb-16 pt-8 md:px-6">
        <ReviewSession courseId={courseId} topicId={topicId} conceptId={conceptId} sessionId={sessionId} />
      </div>
    </>
  )
}
