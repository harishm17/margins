'use client'

import * as React from 'react'
import { InlineAlert } from '@/components/ui/inline-alert'
import { reviewSessionHref } from '@/lib/learning/review-links'
import { Lobby } from './lobby'
import { practiceConceptOf } from './session-state'
import { SessionView } from './session-view'
import { getRecognitionConstructor } from './speech'
import { Summary } from './summary'
import { useVoiceSession } from './use-voice-session'
import { getVoiceUsage, type VoiceUsage } from './voice-api'
import type { VoiceReviewProps } from './voice-review'

/** The real voice practice. Loaded on demand by voice-review.tsx so no other page ships it. */
export function VoiceReviewImpl({ courseId, mode, topic, initialStyle, conceptId, hasClaims, claimsOfIdea }: VoiceReviewProps) {
  const { state, orb, summary, controller } = useVoiceSession({ courseId, mode, topic })
  const [usage, setUsage] = React.useState<VoiceUsage | 'unavailable' | null>(null)
  const [recognitionSupported] = React.useState(() => getRecognitionConstructor() !== null)

  // Minutes left: read whenever the lobby is on screen (first visit, and after a session).
  const inLobby = state.phase === 'lobby'
  React.useEffect(() => {
    if (!inLobby) return
    const abort = new AbortController()
    getVoiceUsage(abort.signal).then(
      (next) => setUsage(next),
      (error) => {
        if (!abort.signal.aborted && !(error instanceof DOMException)) setUsage('unavailable')
      }
    )
    return () => abort.abort()
  }, [inLobby])

  if (mode === 'topic' && !topic) {
    return <InlineAlert tone="danger" title="No topic selected">Open a topic to start a voice practice.</InlineAlert>
  }

  if (state.phase === 'live') {
    return (
      <SessionView
        state={state}
        orb={orb}
        controller={controller}
        title={mode === 'sprint' ? 'Weakest topics sprint' : (topic?.name ?? 'Voice practice')}
        hasQuestions={state.style === 'oral_quiz'}
        recognitionSupported={recognitionSupported}
      />
    )
  }

  if (state.phase === 'summary') {
    return (
      <Summary
        style={state.style}
        summary={summary}
        reason={state.endReason}
        alert={state.alert}
        back={
          mode === 'sprint' || !topic
            ? { href: `/courses/${courseId}/review`, label: 'Back to review' }
            : { href: `/courses/${courseId}/topics/${topic.id}`, label: 'Back to topic' }
        }
        practiceHref={
          practiceConceptOf(summary)
            ? reviewSessionHref(courseId, { conceptId: practiceConceptOf(summary) })
            : reviewSessionHref(courseId, { topicId: mode === 'topic' ? topic?.id : null })
        }
        onRestart={() => controller.reset()}
      />
    )
  }

  return (
    <Lobby
      courseId={courseId}
      mode={mode}
      topic={topic}
      usage={usage}
      limitReached={state.limitReached}
      starting={state.phase === 'starting'}
      lobbyAlert={state.lobbyAlert}
      recognitionSupported={recognitionSupported}
      initialStyle={initialStyle}
      conceptId={conceptId}
      hasClaims={hasClaims}
      claimsOfIdea={claimsOfIdea}
      onStart={(config) => void controller.start(config)}
    />
  )
}
