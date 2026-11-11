'use client'

import { sprintSizeLine, type SprintPreview } from '@/lib/voice/sprint-size'
import * as React from 'react'
import Link from 'next/link'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { BookOpenText, ChalkboardTeacher, CheckCircle, Keyboard, Microphone, Question } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { quizIsMissing, quizMissingCopy, styleNeedsQuiz, type VoiceQuizStatus } from './quiz-status'
import { startingStyleFor } from './starting-style'
import { BUSY_ELSEWHERE, type LobbyAlert } from './errors'
import { focusPlaceholder, minutesLeftLabel } from './format'
import { onDeviceEnvFromWindow, onDeviceReady, speechDestination } from './on-device'
import { CLOUD_TOGGLE_DESCRIPTION, CLOUD_TOGGLE_LABEL, PRIVACY_LINES, PRIVACY_TYPING, cloudPrivacyLine } from './privacy'
import { setVoicePrefs } from './voice-prefs'
import { defaultLanguageCode, hasSpeechSynthesis, isIosDevice, languageTag, VOICE_LANGUAGES } from './speech'
import { SpeakRepliesToggle } from './voice-settings'
import type { StartConfig } from './use-voice-session'
import type { VoiceUsage, VoiceStyle } from './voice-api'
import { useAiStatus } from '@/features/ai/ai-status'

const STYLE_OPTIONS: { value: VoiceStyle; label: string; hint: string; icon: React.ReactNode }[] = [
  { value: 'oral_quiz', label: 'Quiz me', hint: 'The coach asks one question at a time and checks each answer.', icon: <Question aria-hidden /> },
  {
    value: 'teach_back',
    label: 'Teach it back',
    hint: 'Explain an idea from your pages as if to a classmate. The coach asks about what is missing and does not explain first.',
    icon: <ChalkboardTeacher aria-hidden />,
  },
  {
    value: 'guided_reading',
    label: 'Read it with me',
    hint: 'Your pages, one claim at a time: you predict it, hear it, then answer one check question.',
    icon: <BookOpenText aria-hidden />,
  },
]

/** How the day's voice minutes are counted (lib/voice/usage.ts), said where the minutes left are shown. */
const MINUTES_RULE = "Today's minutes count the time you practise. A pause of more than two minutes is not counted."

const LANGUAGE_OPTIONS = VOICE_LANGUAGES.map((language) => ({ value: language.code, label: language.label }))

/** The alerts shown as a box of their own; "open elsewhere" has its own box and changes the start button. */
type ShownAlert = Exclude<LobbyAlert, { kind: 'busy' }>

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
  /** Margins can recognise speech in the cloud here (spec 19.12), and whether the student has it on. */
  cloudOffered?: boolean
  cloudChosen?: boolean
  /** The cloud providers, in the order they are used, for the privacy line. */
  cloudProviders?: readonly string[]
  /** The style to begin with, and the idea a teach-back starts with. */
  initialStyle?: VoiceStyle
  conceptId?: string
  /** False when the topic's pages have no claims yet: Teach it back and Read it with me cannot run, so Quiz me is the start. */
  hasClaims?: boolean
  /** The claims counted by `hasClaims` are the named idea's own, so the lobby says the idea is missing them, not the topic. */
  claimsOfIdea?: boolean
  /** Whether Quiz me can begin, known before Start. Absent: not known, and a start that finds no questions says so. */
  quiz?: VoiceQuizStatus
  /** A quick round's size before it starts. Absent: not known, and the line is left out. */
  sprint?: SprintPreview
  onStart: (config: StartConfig) => void
  /** A card above the controls for the session that ended when the page was hidden ("Pick up where you left off"). */
  resumeCard?: React.ReactNode
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
  cloudOffered = false,
  cloudChosen = false,
  cloudProviders = [],
  initialStyle,
  conceptId,
  hasClaims = true,
  claimsOfIdea = false,
  quiz,
  sprint,
  onStart,
  resumeCard,
}: LobbyProps) {
  // Never begin on a style that cannot run: without claims only Quiz me can (a start that fails for lack of them says so too).
  const needsClaims = !hasClaims || lobbyAlert?.kind === 'needs-claims'
  const startingStyle = startingStyleFor(hasClaims, initialStyle, quizIsMissing(quiz))
  const [style, setStyle] = React.useState<VoiceStyle>(startingStyle)
  // The page can be asked again for another idea or topic without the lobby being remounted: the choice starts over from what the link now says.
  const [seenStart, setSeenStart] = React.useState(`${startingStyle}|${conceptId ?? ''}`)
  if (seenStart !== `${startingStyle}|${conceptId ?? ''}`) {
    setSeenStart(`${startingStyle}|${conceptId ?? ''}`)
    setStyle(startingStyle)
  }
  // A start that failed for lack of claims moves the choice to Quiz me too (state adjusted while rendering, not in an effect).
  const [seenNeedsClaims, setSeenNeedsClaims] = React.useState(needsClaims)
  if (needsClaims !== seenNeedsClaims) {
    setSeenNeedsClaims(needsClaims)
    if (needsClaims) setStyle('oral_quiz')
  }
  const [language, setLanguage] = React.useState(() =>
    defaultLanguageCode(typeof navigator === 'undefined' ? undefined : navigator.language)
  )
  const [focus, setFocus] = React.useState('')
  // How the student answers: out loud, or typed. Chosen before Start, so Start is one button that always says the same thing.
  const [answerBy, setAnswerBy] = React.useState<'speak' | 'type'>('speak')

  // Where the voice goes depends on whether this browser can recognise on the device for this language (pack already installed).
  const tag = languageTag(language)
  const [onDeviceFor, setOnDeviceFor] = React.useState<{ tag: string; ready: boolean } | null>(null)
  React.useEffect(() => {
    if (!recognitionSupported || cloudChosen) return
    let current = true
    void onDeviceReady(onDeviceEnvFromWindow(), tag).then((ready) => {
      if (current) setOnDeviceFor({ tag, ready })
    })
    return () => {
      current = false
    }
  }, [recognitionSupported, cloudChosen, tag])
  const privacyLine = cloudChosen
    ? cloudPrivacyLine(cloudProviders)
    : PRIVACY_LINES[
        speechDestination({
          userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
          ios: isIosDevice(),
          onDevice: onDeviceFor?.tag === tag && onDeviceFor.ready,
        })
      ]

  const remaining = usage && usage !== 'unavailable' ? usage.remainingSeconds : null
  const outOfTime = limitReached || remaining === 0
  // AI unavailable or the day's allowance used: the coach cannot reply, so the session cannot start.
  const { blocked } = useAiStatus()
  const effectiveStyle: VoiceStyle = mode === 'sprint' ? 'oral_quiz' : style

  const note = blocked
    ? blocked.text
    : outOfTime
      ? "You've used today's voice time. It resets within 24 hours."
      : cloudChosen
        ? 'Works best with a microphone and headphones.'
        : recognitionSupported
          ? 'Works best in Chrome, Edge or Safari with a microphone.'
          : null

  // Quiz me with nothing to ask from cannot begin: said here, before Start, with what is missing.
  const quizBlocked = quizIsMissing(quiz) && styleNeedsQuiz(mode, effectiveStyle)
  // Why Teach it back is not on offer stays said even when Quiz me cannot begin either: the quiz line follows it.
  // A voice practice open in another tab or on another device (the usage said so, or a start was just refused for it):
  // starting here ends it there, and the start button says so.
  const busyElsewhere = lobbyAlert?.kind === 'busy' || (usage !== null && usage !== 'unavailable' && usage.hasLiveSession)
  const shownAlert = lobbyAlert?.kind === 'busy' ? null : lobbyAlert
  const alert: ShownAlert | null = shownAlert ?? (hasClaims || mode === 'sprint' ? null : { kind: 'needs-claims', ofIdea: claimsOfIdea })

  // Why the start buttons are off, said to a screen reader with the button and as a tooltip.
  const startReason = outOfTime
    ? 'No voice minutes are left today.'
    : blocked
      ? 'AI features are paused right now.'
      : quizBlocked
        ? 'Quiz me needs a quiz first. The note above says how to make one.'
        : usage === null
          ? 'Checking your minutes for today.'
          : undefined

  const begin = () => {
    if (outOfTime || starting || blocked || quizBlocked) return
    const typed = recognitionSupported && answerBy === 'type'
    onStart({
      style: effectiveStyle,
      language,
      focus,
      ...(effectiveStyle === 'teach_back' && conceptId ? { conceptId } : {}),
      ...(typed ? { typed: true } : {}),
      ...(busyElsewhere ? { takeOver: true } : {}),
    })
  }

  // Quiz me asks from the topic's quiz, so that is where the student goes to make one (a quick round spans topics: the list).
  const createContentHref =
    mode === 'topic' && topic ? `/courses/${courseId}/topics/${topic.id}?view=quiz` : `/courses/${courseId}/topics`
  const quizCopy = quizIsMissing(quiz) ? quizMissingCopy(mode, quiz, mode === 'topic') : null

  return (
    <div className="flex max-w-[640px] flex-col gap-6" data-testid="voice-lobby">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-heading text-fg">{mode === 'sprint' ? 'Voice practice: quick round' : 'Voice practice'}</h2>
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
        <p className="text-body text-fg-2">
          {recognitionSupported ? 'Answer questions out loud and get feedback, like a study partner.' : 'Answer questions and get feedback, like a study partner.'}
        </p>
        {mode === 'sprint' && sprint ? (
          // The round's own size, known before the start: said here, beside the minutes left.
          <p className="text-small text-fg-2" data-testid="voice-sprint-size">
            {sprintSizeLine(sprint)}
          </p>
        ) : null}
        <p className="text-small text-fg-2" data-testid="voice-minutes-rule">
          {MINUTES_RULE}
        </p>
        {recognitionSupported ? null : (
          <p className="mt-1 flex items-start gap-2 text-small text-fg-2" data-testid="voice-no-recognition">
            <Keyboard aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-3" />
            This browser can&apos;t listen, so you will type your answers. Talking works in Chrome, Edge and Safari.
          </p>
        )}
      </div>

      {resumeCard}
      {alert ? <LobbyAlertView alert={alert} createContentHref={createContentHref} mode={mode} quizWorks={!quizBlocked} /> : null}
      {quizBlocked && quizCopy && (!alert || alert.kind === 'needs-claims') ? (
        <InlineAlert
          tone="warning"
          title={quizCopy.title}
          data-testid="voice-quiz-missing"
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={createContentHref}>{quizCopy.action}</Link>
            </Button>
          }
        >
          {quizCopy.text}
        </InlineAlert>
      ) : null}
      {busyElsewhere ? (
        <InlineAlert tone="warning" title={BUSY_ELSEWHERE.title} data-testid="voice-busy-elsewhere">
          {BUSY_ELSEWHERE.text}
        </InlineAlert>
      ) : null}

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          begin()
        }}
      >
        {mode === 'topic' ? (
          <div className="flex flex-col gap-1.5">
            <span id="voice-style-label" className="text-small font-medium text-fg">
              Style
            </span>
            <RadioGroup.Root
              aria-labelledby="voice-style-label"
              value={style}
              onValueChange={(next) => setStyle(next as VoiceStyle)}
              disabled={starting}
              orientation="horizontal"
              loop
              className="grid gap-2 sm:grid-cols-3"
              data-testid="voice-styles"
            >
              {STYLE_OPTIONS.map((option) => (
                <RadioGroup.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    'group relative flex flex-col items-start gap-1.5 rounded-card border border-border bg-surface p-3.5 text-left max-sm:min-h-11',
                    // On a phone a card is one short row (icon, name, then the hint under the name), so all three show at once.
                    'max-sm:grid max-sm:grid-cols-[auto_1fr] max-sm:gap-x-3 max-sm:gap-y-0.5 max-sm:p-3 max-sm:pr-9',
                    'transition-[border-color,background-color] duration-120',
                    'hover:border-border-strong disabled:opacity-60',
                    'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft'
                  )}
                >
                  <span className="flex text-accent max-sm:row-span-2 max-sm:mt-0.5 [&>svg]:size-5">{option.icon}</span>
                  {/* An empty circle with a 3:1 edge when it is not chosen, so the choice shows without the colour of the card. */}
                  <span
                    aria-hidden="true"
                    className="absolute right-3 top-3 size-4 shrink-0 rounded-full border-[1.5px] border-control group-data-[state=checked]:hidden"
                  />
                  <CheckCircle
                    weight="fill"
                    aria-hidden
                    className="absolute right-3 top-3 size-4 shrink-0 text-accent opacity-0 group-data-[state=checked]:opacity-100"
                  />
                  <span className="text-small font-medium text-fg">{option.label}</span>
                  <span className="text-caption font-normal text-fg-2">{option.hint}</span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
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

        <div className="flex flex-col gap-3">
          {hasSpeechSynthesis() ? <SpeakRepliesToggle disabled={starting} compact /> : null}
          {cloudOffered ? (
            <Checkbox
              checked={cloudChosen}
              onCheckedChange={(checked) => setVoicePrefs({ recognition: checked === true ? 'cloud' : 'browser' })}
              disabled={starting}
              label={CLOUD_TOGGLE_LABEL}
              description={CLOUD_TOGGLE_DESCRIPTION}
              data-testid="voice-cloud-toggle"
            />
          ) : null}
          {recognitionSupported ? (
            <p className="flex flex-wrap items-baseline gap-x-1 text-small text-fg-2" data-testid="voice-privacy">
              <span>
                {privacyLine} {PRIVACY_TYPING}
              </span>
            </p>
          ) : null}
        </div>

        {recognitionSupported ? (
          <div className="flex flex-col gap-1.5">
            <span id="voice-answer-by-label" className="text-small font-medium text-fg">
              How you answer
            </span>
            <SegmentedControl<'speak' | 'type'>
              aria-labelledby="voice-answer-by-label"
              value={answerBy}
              onValueChange={setAnswerBy}
              disabled={starting}
              className="self-start"
              options={[
                { value: 'speak', label: 'Speak your answers' },
                { value: 'type', label: 'Type answers instead' },
              ]}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            icon={recognitionSupported && answerBy === 'type' ? <Keyboard /> : <Microphone />}
            loading={starting}
            disabled={outOfTime || usage === null || !!blocked || quizBlocked}
            disabledReason={startReason}
          >
            {busyElsewhere ? 'Start here instead' : 'Start voice practice'}
          </Button>
          {note ? <p className="max-w-[34ch] text-small text-fg-2">{note}</p> : null}
        </div>
      </form>
    </div>
  )
}

function LobbyAlertView({
  alert,
  createContentHref,
  mode,
  quizWorks,
}: {
  alert: ShownAlert
  createContentHref: string
  mode: 'topic' | 'sprint'
  /** Whether Quiz me can begin: the claims alert says so only when it is true. */
  quizWorks: boolean
}) {
  if (alert.kind === 'needs-generation') {
    // The page did not know (or the quiz changed since): the same words the lobby shows up front.
    const copy = quizMissingCopy(mode, { state: 'missing', reason: 'no_quiz', total: 0 }, mode === 'topic')
    return (
      <InlineAlert
        tone="warning"
        title={copy.title}
        action={
          <Button asChild size="sm" variant="secondary">
            <Link href={createContentHref}>{copy.action}</Link>
          </Button>
        }
      >
        {copy.text}
      </InlineAlert>
    )
  }
  if (alert.kind === 'needs-claims') {
    return (
      <InlineAlert tone="warning" title={alert.ofIdea ? "This idea isn't read from your pages yet" : "Your pages aren't read into ideas yet"}>
        {alert.ofIdea
          ? `Teach it back uses what your own pages say about an idea, and this idea doesn't have anything yet.${quizWorks ? ' Quiz me still works.' : ''}`
          : `Teach it back and Read it with me use the ideas from your own pages, and this topic doesn't have any yet.${quizWorks ? ' Quiz me still works.' : ''}`}
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
