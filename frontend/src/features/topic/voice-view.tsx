import { VoiceReview } from '@/features/voice/voice-review'

/**
 * Voice practice for a topic: the voice coach in topic mode. The coach itself loads lazily from
 * VoiceReview, so this view adds nothing to the topic page's first load.
 */
export function VoiceView({ courseId, topic }: { courseId: string; topic: { id: string; name: string; keywords?: string[] } }) {
  return <VoiceReview courseId={courseId} mode="topic" topic={topic} />
}
