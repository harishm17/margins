'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

export type VoiceReviewProps = {
  courseId: string
  /** `topic`: a drill on one topic (needs `topic`). `sprint`: the course's 3 weakest topics. */
  mode: 'topic' | 'sprint'
  topic?: { id: string; name: string }
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
