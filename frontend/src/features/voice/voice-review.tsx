'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import type { SprintPreview } from '@/lib/voice/sprint-size'
import type { VoiceQuizStatus } from './quiz-status'

export type VoiceReviewProps = {
  courseId: string
  /** `topic`: a drill on one topic (needs `topic`). `sprint`: the course's 3 weakest topics. */
  mode: 'topic' | 'sprint'
  /** `keywords`: the topic's key terms, for the Focus field's example. */
  topic?: { id: string; name: string; keywords?: string[] }
  /** The style the lobby has chosen to begin with (a link such as "Do it out loud" names it). */
  initialStyle?: 'oral_quiz' | 'teach_back' | 'guided_reading'
  /** The idea a teach-back starts with. */
  conceptId?: string
  /** False when what Teach it back needs is missing: the claims of the named idea, else of the topic. The lobby then starts on Quiz me. */
  hasClaims?: boolean
  /** The claims counted are the named idea's, not the topic's (the lobby says which is missing). */
  claimsOfIdea?: boolean
  /** Whether Quiz me can begin (worked out on the server). Absent: not known, so the lobby only finds out at Start. */
  quiz?: VoiceQuizStatus
  /** A quick round's size before it starts (worked out on the server). */
  sprint?: SprintPreview
}

function LobbySkeleton() {
  return (
    <div className="flex max-w-[560px] flex-col gap-6" aria-busy="true" aria-label="Loading voice practice">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40 rounded-chip" />
        <Skeleton className="h-4 w-72 rounded-chip" />
      </div>
      <Skeleton className="h-[34px]" />
      <Skeleton className="h-[34px]" />
      <Skeleton className="h-[34px]" />
      <Skeleton className="h-10 w-44" />
    </div>
  )
}

// Everything voice (recognition, speech, the orb, the turn stream) is one lazy chunk. It loads
// only when a page renders <VoiceReview />, never with the pages around it. It needs the
// browser (speech, microphone), so it is not rendered on the server.
const VoiceReviewImpl = dynamic(() => import('./voice-review-impl').then((module) => module.VoiceReviewImpl), {
  ssr: false,
  loading: () => <LobbySkeleton />,
})

/**
 * Voice practice: lobby, live session, summary. Render it inside the
 * topic page's Voice practice view (mode "topic") or on the sprint page (mode "sprint").
 */
export function VoiceReview(props: VoiceReviewProps) {
  return <VoiceReviewImpl {...props} />
}
