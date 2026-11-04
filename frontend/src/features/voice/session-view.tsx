'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import {
  Check,
  HandPalm,
  Keyboard,
  Lightbulb,
  Microphone,
  MicrophoneSlash,
  PaperPlaneRight,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
} from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Textarea } from '@/components/ui/textarea'
import { Board } from './board'
import type { VoiceAlert } from './errors'
import { isDoneShortcut } from './shortcuts'
import { ORB_LABEL, orbLabel, type MicNotice, type OrbState, type SessionState } from './session-state'
import { Transcript } from './transcript'
import { useVoiceDraft } from './use-voice-draft'
import type { VoiceController } from './voice-controller'
import { VoiceOrb } from './voice-orb'
import { VoiceSettings } from './voice-settings'

type SessionViewProps = {
  state: SessionState
  orb: OrbState
  controller: VoiceController
  /** The topic's name, or the round's name for a quick round. */
  title: string
  /** Quiz style: Hint and Skip make sense. */
  hasQuestions: boolean
  recognitionSupported: boolean
}

const MIC_NOTICES: Record<MicNotice, { tone: 'neutral' | 'warning'; title?: string; text: string; retry: boolean }> = {
  unsupported: { tone: 'neutral', text: "Voice input isn't supported in this browser. You can type your answers.", retry: false },
  language: {
    tone: 'warning',
    text: "Voice input isn't available for this language in your browser. You can type your answers.",
    retry: false,
  },
  denied: {
    tone: 'warning',
    title: 'Microphone access is blocked',
    text: 'Allow the microphone in your browser settings, or keep typing your answers.',
    retry: true,
  },
  'no-mic': { tone: 'warning', title: "We couldn't find a microphone", text: 'Plug one in, or type your answers.', retry: true },
  network: { tone: 'warning', title: 'Voice input lost its connection', text: 'You can type your answers.', retry: true },
  unstable: { tone: 'warning', title: 'Voice input keeps stopping', text: 'You can type your answers.', retry: true },
}

export function SessionView({ state, orb, controller, title, hasQuestions, recognitionSupported }: SessionViewProps) {
  const { question, board, entries, interim, inputMode, micPaused, speech, turnActive, alert, micNotice } = state
  // The unsent typed answer survives a reload (the session itself ends when the page is hidden; the lobby offers to continue it).
  const { courseId } = useParams<{ courseId: string }>()
  const { draft, setDraft, clear: clearDraft } = useVoiceDraft(courseId)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const textMode = inputMode === 'text'
  // No speech recognition here (the lobby said so before the start): the text box is the way in, with no mic to look at.
  const textOnly = textMode && !recognitionSupported
  // Typing with replies read aloud keeps the orb (it shows the coach speaking); typing without speech has nothing for it to show,
  // so the field comes straight after the question and a one-line status replaces it.
  const showOrb = !textOnly && !(textMode && speech !== 'on')

  React.useEffect(() => {
    if (textMode) inputRef.current?.focus()
  }, [textMode])

  // Done from the keyboard: Enter, when no field or button has the focus (never while typing an answer).
  const hasWords = interim.trim() !== ''
  React.useEffect(() => {
    if (textMode || micPaused || !hasWords) return
    const onKey = (event: KeyboardEvent) => {
      if (!isDoneShortcut(event, event.target as Element | null)) return
      event.preventDefault()
      controller.done()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller, textMode, micPaused, hasWords])

  const send = (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || turnActive) return
    controller.sendText(draft)
    clearDraft()
  }

  return (
    <section
      aria-label="Voice practice session"
      data-testid="voice-session"
      className="max-md:fixed max-md:inset-0 max-md:z-modal max-md:overflow-y-auto max-md:bg-canvas"
    >
      <div className="flex w-full max-w-[720px] flex-col px-4 max-md:min-h-full md:px-0">
        <header className="flex items-center justify-between gap-4 border-b border-border max-md:h-14 max-md:shrink-0 md:border-b-0 md:pb-2">
          <p className="tabular min-w-0 truncate text-small text-fg-2" data-testid="voice-progress">
            {question ? `Question ${question.index} of ${question.total}` : title}
          </p>
          <Button variant="secondary" size="sm" onClick={() => controller.end()}>
            End
          </Button>
        </header>

        <div className="flex flex-1 flex-col gap-6 pb-6 pt-5">
          <Board board={board} />

          {!showOrb ? (
            <p role="status" aria-live="polite" className="h-6 self-center text-body-strong text-fg-2" data-testid="voice-text-status">
              {orb === 'thinking' || orb === 'speaking' ? ORB_LABEL[orb] : ''}
            </p>
          ) : (
            <VoiceOrb state={orb} meter={controller.meter} label={orbLabel(orb, state.holding)} className="self-center py-2" size={textMode ? 'sm' : 'md'} />
          )}


          {/* Under the orb, in a slot that keeps its height: Interrupt while the coach speaks, Done while the student's words wait to be sent. */}
          {!textOnly && (!textMode || speech === 'on') ? (
            <div className="-mt-3 flex h-9 items-center justify-center self-center" data-testid="voice-turn-control">
              {state.speaking && speech === 'on' ? (
                <Button variant="secondary" size="sm" icon={<HandPalm />} onClick={() => controller.interrupt()} data-testid="voice-interrupt">
                  Interrupt
                </Button>
              ) : !textMode && !micPaused && hasWords ? (
                <Button
                  variant={state.holding ? 'primary' : 'secondary'}
                  size="sm"
                  icon={<Check />}
                  aria-keyshortcuts="Enter Control+Enter Meta+Enter"
                  data-testid="voice-done"
                  onClick={() => controller.done()}
                >
                  Done
                  <kbd className="rounded-chip border border-border px-1 text-caption font-normal text-fg-3 max-md:hidden" aria-hidden="true">
                    Enter
                  </kbd>
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            {micNotice && !(micNotice === 'unsupported' && textOnly) ? <MicNoticeView notice={micNotice} onRetry={() => void controller.enableMicrophone()} /> : null}
            {alert ? <TurnAlert alert={alert} onRetry={() => controller.retry()} onDismiss={() => controller.dismissAlert()} /> : null}
          </div>

          <Transcript entries={entries} interim={interim} />

          <div
            className={cn(
              'flex flex-col gap-3 max-md:sticky max-md:bottom-0 max-md:bg-canvas max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:pt-3',
              // Typing: the field follows the question instead of sitting at the foot of an empty screen.
              !textMode && 'max-md:mt-auto'
            )}
          >
            {textMode ? (
              // A voice answer is an explanation, so the typed one is a multiline field: two lines to start, growing as it fills.
              // With a keyboard, Enter sends and Shift+Enter starts a new line; on a touch screen Enter is a new line and Send sends.
              <form onSubmit={send} className="flex flex-col gap-2">
                <label htmlFor="voice-answer" className="text-body-strong text-fg">
                  Type your answer
                </label>
                <div className="flex items-end gap-2">
                  <Textarea
                    id="voice-answer"
                    ref={inputRef}
                    value={draft}
                    rows={2}
                    maxRows={8}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                      if (!window.matchMedia('(pointer: fine)').matches) return
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }}
                    placeholder="Your answer"
                    maxLength={2000}
                    autoComplete="off"
                    enterKeyHint="enter"
                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" variant="primary" icon={<PaperPlaneRight />} disabled={!draft.trim() || turnActive} className="shrink-0">
                    Send
                  </Button>
                </div>
              </form>
            ) : null}

            <div className="flex flex-wrap items-center justify-center gap-2" data-testid="voice-controls">
              {textMode ? (
                recognitionSupported ? (
                  <Button variant="secondary" icon={<Microphone />} onClick={() => controller.toggleMic()}>
                    Use microphone
                  </Button>
                ) : null
              ) : (
                <>
                  <Button
                    variant={micPaused ? 'primary' : 'secondary'}
                    icon={micPaused ? <MicrophoneSlash /> : <Microphone />}
                    aria-pressed={micPaused}
                    onClick={() => controller.toggleMic()}
                  >
                    {micPaused ? 'Resume mic' : 'Pause mic'}
                  </Button>
                  <Button variant="ghost" icon={<Keyboard />} onClick={() => controller.typeInstead()}>
                    Type instead
                  </Button>
                </>
              )}
              {hasQuestions ? (
                <>
                  <Button variant="ghost" icon={<Lightbulb />} disabled={turnActive} onClick={() => controller.hint()}>
                    Hint
                  </Button>
                  <Button variant="ghost" icon={<SkipForward />} disabled={turnActive} onClick={() => controller.skip()}>
                    Skip
                  </Button>
                </>
              ) : null}
              {speech !== 'unsupported' ? (
                <IconButton
                  variant="ghost"
                  label="Speak replies"
                  icon={speech === 'on' ? <SpeakerHigh /> : <SpeakerSlash />}
                  aria-pressed={speech === 'on'}
                  onClick={() => controller.toggleSpeech()}
                />
              ) : null}
              {speech !== 'unsupported' ? <VoiceSettings language={state.language} onPreview={() => controller.previewVoice()} /> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function MicNoticeView({ notice, onRetry }: { notice: MicNotice; onRetry: () => void }) {
  const copy = MIC_NOTICES[notice]
  return (
    <InlineAlert
      tone={copy.tone}
      title={copy.title}
      data-testid="voice-mic-notice"
      action={
        copy.retry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try the mic again
          </Button>
        ) : null
      }
    >
      {copy.text}
    </InlineAlert>
  )
}

function TurnAlert({ alert, onRetry, onDismiss }: { alert: VoiceAlert; onRetry: () => void; onDismiss: () => void }) {
  const pathname = usePathname()
  return (
    <InlineAlert
      tone={alert.tone}
      title={alert.title}
      data-testid="voice-alert"
      action={
        alert.action === 'retry' ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : alert.action === 'sign-in' ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={`/login?next=${encodeURIComponent(pathname)}`}>Sign in</Link>
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )
      }
    >
      {alert.text}
    </InlineAlert>
  )
}
