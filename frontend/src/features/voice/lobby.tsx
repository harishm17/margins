'use client'

import * as React from 'react'
import Link from 'next/link'
import { Microphone } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import type { LobbyAlert } from './errors'
import { focusPlaceholder, minutesLeftLabel } from './format'
import { defaultLanguageCode, VOICE_LANGUAGES } from './speech'
import type { StartConfig } from './use-voice-session'
import type { VoiceUsage, VoiceStyle } from './voice-api'

const STYLE_OPTIONS: { value: VoiceStyle; label: string; hint: string }[] = [
  { value: 'oral_quiz', label: 'Quiz me', hint: 'The coach asks one question at a time and checks each answer.' },
  { value: 'guided_notes', label: 'Walk me through it', hint: 'The coach goes through the topic notes with you and checks you follow.' },
  { value: 'topic_conversation', label: 'Just talk', hint: 'An open conversation about the topic. Nothing is graded.' },
]

const LANGUAGE_OPTIONS = VOICE_LANGUAGES.map((language) => ({ value: language.code, label: language.label }))

type LobbyProps = {
  courseId: string
  mode: 'topic' | 'sprint'
  topic?: { id: string; name: string; keywords?: string[] }
  /** null while loading, 'unavailable' when the usage request failed. */
  usage: VoiceUsage | 'unavailable' | null
  limitReached: boolean
  starting: boolean
  lobbyAlert: LobbyAlert | null
  recognitionSupported: boolean
  onStart: (config: StartConfig) => void
}

export function Lobby({
  courseId,
  mode,
  topic,
  usage,
  limitReached,
  starting,
  lobbyAlert,
  recognitionSupported,
  onStart,
}: LobbyProps) {
  const [style, setStyle] = React.useState<VoiceStyle>('oral_quiz')
  const [language, setLanguage] = React.useState(() =>
    defaultLanguageCode(typeof navigator === 'undefined' ? undefined : navigator.language)
  )
  const [focus, setFocus] = React.useState('')
  const styleHintId = React.useId()

  const remaining = usage && usage !== 'unavailable' ? usage.remainingSeconds : null
  const outOfTime = limitReached || remaining === 0
  const styleHint = STYLE_OPTIONS.find((option) => option.value === style)?.hint
  const effectiveStyle: VoiceStyle = mode === 'sprint' ? 'oral_quiz' : style

  const createContentHref =
    mode === 'topic' && topic ? `/courses/${courseId}/topics/${topic.id}?view=notes` : `/courses/${courseId}/topics`

  return (
    <div className="flex max-w-[560px] flex-col gap-6" data-testid="voice-lobby">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-heading text-fg">{mode === 'sprint' ? 'Start a sprint' : 'Voice practice'}</h2>
          <div className="flex h-[26px] shrink-0 items-center" aria-live="polite">
            {usage === null ? (
              <Skeleton className="h-4 w-28 rounded-chip" />
            ) : remaining === null ? null : remaining < 5 * 60 ? (
              <Badge tone="warning" className="tabular">
                {minutesLeftLabel(remaining)}
              </Badge>
            ) : (
              <span className="tabular text-small text-fg-2">{minutesLeftLabel(remaining)}</span>
            )}
          </div>
        </div>
        <p className="text-body text-fg-2">Answer questions out loud and get feedback, like a study partner.</p>
      </div>

      {lobbyAlert ? <LobbyAlertView alert={lobbyAlert} createContentHref={createContentHref} mode={mode} /> : null}
      {!lobbyAlert && usage && usage !== 'unavailable' && usage.hasLiveSession ? (
        <InlineAlert tone="warning" title="Another voice practice looks open">
          If it is open in another tab or window, end it there first. It also clears by itself after about a minute.
        </InlineAlert>
      ) : null}

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!outOfTime && !starting) onStart({ style: effectiveStyle, language, focus })
        }}
      >
        {mode === 'topic' ? (
          <div className="flex flex-col gap-1.5">
            <span id="voice-style-label" className="text-small font-medium text-fg">
              Style
            </span>
            <SegmentedControl
              aria-labelledby="voice-style-label"
              options={STYLE_OPTIONS.map(({ value, label }) => ({ value, label }))}
              value={style}
              onValueChange={setStyle}
              disabled={starting}
              fullWidth
            />
            <p id={styleHintId} className="text-caption font-normal text-fg-3">
              {styleHint}
            </p>
          </div>
        ) : null}

        <Field label="Language">
          <Select options={LANGUAGE_OPTIONS} value={language} onValueChange={setLanguage} disabled={starting} />
        </Field>

        <Field label="Focus" optional>
          <Input
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder={focusPlaceholder(mode === 'topic' ? topic?.keywords : undefined)}
            maxLength={280}
            disabled={starting}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            icon={<Microphone />}
            loading={starting}
            disabled={outOfTime || usage === null}
          >
            {mode === 'sprint' ? 'Start sprint' : 'Start voice practice'}
          </Button>
          <p className="max-w-[34ch] text-small text-fg-2">
            {outOfTime
              ? "You've used today's voice time. It resets within 24 hours."
              : recognitionSupported
                ? 'Works best in Chrome, Edge or Safari with a microphone.'
                : "This browser can't hear you, so you will type your answers."}
          </p>
        </div>
      </form>
    </div>
  )
}

function LobbyAlertView({
  alert,
  createContentHref,
  mode,
}: {
  alert: LobbyAlert
  createContentHref: string
  mode: 'topic' | 'sprint'
}) {
  if (alert.kind === 'needs-generation') {
    return (
      <InlineAlert
        tone="warning"
        title="Create notes and a quiz first"
        action={
          <Button asChild size="sm" variant="secondary">
            <Link href={createContentHref}>Create them</Link>
          </Button>
        }
      >
        {mode === 'sprint'
          ? "These topics don't have quiz questions yet. Create their notes and a quiz, then come back."
          : "There are no questions to ask yet. Create this topic's notes and a quiz, then come back. Walk me through it and Just talk work without them."}
      </InlineAlert>
    )
  }
  if (alert.kind === 'turn') {
    return (
      <InlineAlert tone={alert.alert.tone} title={alert.alert.title}>
        {alert.alert.text}
      </InlineAlert>
    )
  }
  return (
    <InlineAlert tone="danger" title="We couldn't start">
      {alert.text}
    </InlineAlert>
  )
}
