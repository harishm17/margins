'use client'

import { FocusHeader } from '@/components/shell/slots'
import type { SprintPreview } from '@/lib/voice/sprint-size'
import type { VoiceQuizStatus } from './quiz-status'
import { VoiceReview } from './voice-review'

/**
 * The voice practice screen: a heading, the topics it covers, then the lobby, live session and
 * summary in one place. The page keeps a minimum height so starting a session does not move it.
 */
export function VoiceFocus({
  courseId,
  courseName,
  description,
  quiz,
  sprint,
}: {
  courseId: string
  courseName: string
  description: string
  quiz?: VoiceQuizStatus
  sprint?: SprintPreview
}) {
  return (
    <>
      <FocusHeader title={courseName} />
      <div className="mx-auto min-h-[calc(100dvh-var(--topbar-height))] w-full max-w-[720px] px-4 pb-16 pt-8 md:px-6">
        <h1 className="text-title text-fg">Voice practice</h1>
        <p className="mt-1 mb-8 text-body text-fg-2">{description}</p>
        <VoiceReview courseId={courseId} mode="sprint" quiz={quiz} sprint={sprint} />
      </div>
    </>
  )
}
