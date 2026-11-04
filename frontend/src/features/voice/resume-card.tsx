'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { clip } from './format'
import {
  clearVoiceSnapshot,
  describeSnapshot,
  readVoiceSnapshot,
  resumeOpening,
  startResume,
  type VoiceSnapshot,
} from './use-voice-draft'
import type { StartConfig } from './voice-controller'

type Props = {
  courseId: string
  /** The topic id, or `sprint`: the card only offers a practice of the same scope. */
  scope: string
  starting?: boolean
  /** Start a new session on the same scope; `opening` makes the coach ask the last question again. */
  onContinue: (config: StartConfig, opening: string | null) => void
}

/**
 * A practice that was cut short by a reload: the last question, anything typed and not sent, and two ways on. Continue starts a
 * new session (the old one was closed on the server) and gives the words back; Start fresh forgets them. The snapshot lives in this tab's storage.
 */
export function ResumeCard({ courseId, scope, starting, onContinue }: Props) {
  // The practice loads in the browser only (no server render), so the snapshot can be read straight away.
  const [snapshot, setSnapshot] = React.useState<VoiceSnapshot | null>(() => {
    const held = readVoiceSnapshot(courseId, scope)
    return held && (held.entries.length > 0 || held.restored.length > 0 || held.draft.trim() !== '') ? held : null
  })

  if (!snapshot) return null
  const { lastCoach, draft, answers } = describeSnapshot(snapshot)
  const forget = () => {
    clearVoiceSnapshot(courseId, scope)
    setSnapshot(null)
  }
  return (
    <Card className="flex max-w-[640px] flex-col gap-3" data-testid="voice-resume">
      <div>
        <h2 className="text-subheading text-fg">Pick up where you left off</h2>
        <p className="mt-1 text-small text-fg-2">
          Your last practice stopped when the page reloaded.
          {answers > 0 ? ` You had sent ${answers === 1 ? 'one answer' : `${answers} answers`}.` : ''}
        </p>
      </div>
      {lastCoach ? (
        <p className="text-small text-fg" data-testid="voice-resume-question">
          <span className="text-fg-2">Last question: </span>
          {clip(lastCoach, 200)}
        </p>
      ) : null}
      {draft.trim() ? (
        <p className="text-small text-fg" data-testid="voice-resume-draft">
          <span className="text-fg-2">You had typed, not sent: </span>
          {clip(draft, 200)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={starting}
          onClick={() => {
            startResume(snapshot)
            setSnapshot(null)
            onContinue(snapshot.config, resumeOpening(snapshot))
          }}
        >
          Continue
        </Button>
        <Button variant="ghost" disabled={starting} onClick={forget}>
          Start fresh
        </Button>
      </div>
    </Card>
  )
}
