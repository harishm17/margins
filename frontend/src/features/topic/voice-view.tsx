import type { VoiceQuizStatus } from '@/features/voice/quiz-status'
import { VoiceReview } from '@/features/voice/voice-review'

/**
 * Voice practice for a topic: the voice coach in topic mode. The coach itself loads lazily from
 * VoiceReview, so this view adds nothing to the topic page's first load.
 */
export function VoiceView({
  courseId,
  topic,
  initialStyle,
  conceptId,
  hasClaims,
  claimsOfIdea,
  quiz,
}: {
  courseId: string
  topic: { id: string; name: string; keywords?: string[] }
  initialStyle?: 'oral_quiz' | 'teach_back' | 'guided_reading'
  conceptId?: string
  hasClaims?: boolean
  claimsOfIdea?: boolean
  quiz?: VoiceQuizStatus
}) {
  return <VoiceReview courseId={courseId} mode="topic" topic={topic} initialStyle={initialStyle} conceptId={conceptId} hasClaims={hasClaims} claimsOfIdea={claimsOfIdea} quiz={quiz} />
}
