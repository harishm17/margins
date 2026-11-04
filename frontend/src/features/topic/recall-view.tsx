'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, CaretDown, CheckCircle, Eye, Microphone, MicrophoneSlash, MinusCircle, Question } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { LazyMarkdownInline } from '@/components/ui/lazy-markdown'
import { quoteOnOneLine } from '@/lib/chat/citations'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, isApiError } from '@/lib/api/client'
import { MAX_RECALL_ANSWER_CHARS, type RecallCard, type RecallFeedback, type RecallState, type RevealedClaim } from '@/lib/learning/recall-shared'
import { defaultLanguageCode, getRecognitionConstructor, languageTag, newFinalWords, resultsFromEvent, type RecognitionLike } from '@/features/voice/speech'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { cn } from '@/lib/utils'
import { activityVerb, opensHere } from './activity-copy'
import { clearDraft, draftKey, openDraft, parseDraft, parseRecallPayload, type RecallDraftPayload } from './recall-draft'
import { useActivityInProgress, useOptionalTopic } from './topic-provider'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'
import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { useFocusRequest } from '@/lib/hooks/use-focus'

type Props = {
  topicId: string
  state: RecallState
  /** Where the step goes on to once the student is done (or skips it). */
  nextHref: string
  nextLabel: string
  /** What to do next on the topic (it changes once an answer is graded: the page is read again). */
  next: { kind: ActivityKind; href: string }
  /** A teach-back can be done out loud: the voice lobby with Teach it back chosen for this idea. */
  voiceHref?: string
}

type Submitted =
  | { status: 'graded'; feedback: RecallFeedback }
  | { status: 'ungraded'; clarifyingQuestion: string }

const noSubscribe = () => () => {}

/** The browser can turn speech into text (Chrome, Edge, Safari): dictation is offered only then. */
const useCanDictate = () => React.useSyncExternalStore(noSubscribe, () => getRecognitionConstructor() !== null, () => false)

/** The card's older, sessionStorage-only draft (text, and the reading-was-opened mark): read when the page shows, never during the server render. */
function useStoredDraft(topicId: string, cardKey: string) {
  const raw = React.useSyncExternalStore(
    noSubscribe,
    () => {
      try {
        return window.sessionStorage.getItem(draftKey(topicId, cardKey))
      } catch {
        return null
      }
    },
    () => null
  )
  return React.useMemo(() => parseDraft(raw), [raw])
}

const storage = (): Storage | null => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * The Recall step (spec §5.3): close the book and write what you remember, a card per objective and one for the
 * whole topic, or a teach-back of one idea. The reading is not on this page. An answer is graded against the
 * claims of the student's own pages, and what comes back is about what they wrote: their words first, what is
 * wrong with the page's words, and pointers to what they missed. "Show me what I missed" is a separate choice.
 */
export function RecallView({ topicId, state, nextHref, nextLabel, next, voiceHref }: Props) {
  const teachBack = state.mode === 'teach_back'
  const pathname = usePathname()
  const search = useSearchParams()
  // The first graded answer counts as "recalled" for the topic (the learning model needs one), but the step is only
  // finished when every prompt has an answer, so the page counts them and keeps the rest in front of the student.
  const [answeredKeys, setAnsweredKeys] = React.useState(() => new Set(state.cards.filter((card) => card.latest !== null).map((card) => card.key)))
  const graded = answeredKeys.size > 0
  const total = state.cards.length
  const complete = answeredKeys.size >= total
  const [instructionsOpen, setInstructionsOpen] = React.useState(false)
  const instructionsId = React.useId()
  // One prompt is open at a time: the first without an answer, or the one the student picked. The other unanswered prompts
  // are one labelled row each, so four boxes and four Check buttons are not all asking at once. Answered prompts stay open
  // with their feedback, which is what the student came back to read.
  const [picked, setPicked] = React.useState<string | null>(null)
  const firstUnanswered = state.cards.find((card) => !answeredKeys.has(card.key))?.key ?? null
  const activeKey = picked !== null && !answeredKeys.has(picked) ? picked : firstUnanswered
  const nextAfter = (key: string): string | null => {
    const at = state.cards.findIndex((card) => card.key === key)
    return state.cards.slice(at + 1).find((card) => !answeredKeys.has(card.key))?.key ?? state.cards.find((card) => card.key !== key && !answeredKeys.has(card.key))?.key ?? null
  }
  const openPrompt = (key: string) => {
    setPicked(key)
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLElement>(`textarea[aria-labelledby="recall-${key}"]`)
      box?.focus()
    })
  }
  // This view ends in its own next step, so the topic's next-activity card does not repeat it above.
  useActivityInProgress(true)
  // Once something is graded the way on is the topic's next activity, as the primary button; with nothing
  // graded yet (or the next activity being recall itself) the step offers to skip on to the one after it.
  const onward = graded && complete && !opensHere(next.href, pathname, search) ? { href: next.href, label: activityVerb(next.kind) } : { href: nextHref, label: nextLabel }
  // With results on the page they come first: the instructions fold into one line.
  const folded = graded && !instructionsOpen
  return (
    <section aria-labelledby="recall-heading" className="max-w-[640px]">
      <h2 id="recall-heading" className="text-title text-fg">
        {teachBack ? 'Explain it in your own words' : 'Close the book and say what you remember'}
      </h2>
      {graded ? (
        <button
          type="button"
          aria-expanded={instructionsOpen}
          aria-controls={instructionsId}
          onClick={() => setInstructionsOpen((current) => !current)}
          className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-chip text-small text-fg-2 hover:text-fg max-sm:min-h-11"
        >
          {instructionsOpen ? 'Hide instructions' : 'Show instructions'}
          <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', instructionsOpen && 'rotate-180')} />
        </button>
      ) : null}
      <div id={instructionsId} hidden={folded}>
        <p className="mt-3 text-body text-fg-2">
          {teachBack
            ? 'Teach it as if the other person had not read it. What you leave out shows what to look at again.'
            : 'Write what you can remember of each idea, without looking back. Gaps are fine: they show what to look at next.'}
        </p>
        <p className="mt-2 text-body text-fg-2">The reading stays closed while you answer. If you open it, the answer won&apos;t count toward your score.</p>
      </div>
      {total > 1 ? (
        <p className="mt-4 text-small text-fg-2" data-testid="recall-progress">
          {answeredKeys.size} of {total} prompts answered{complete ? '' : '. Answer the rest, or move on.'}
        </p>
      ) : null}
      <ol className="mt-8 divide-y divide-border">
        {state.cards.map((card) => {
          const collapsed = total > 1 && !answeredKeys.has(card.key) && card.key !== activeKey
          const following = nextAfter(card.key)
          return (
            <li key={card.key} className={collapsed ? 'py-3 first:pt-0' : 'py-8 first:pt-0'}>
              {collapsed ? (
                <button
                  type="button"
                  onClick={() => openPrompt(card.key)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-control border border-border px-3.5 py-2 text-left hover:border-border-strong"
                >
                  <span className="min-w-0 flex-1 text-body-strong text-fg">{card.prompt}</span>
                  <span className="shrink-0 text-caption text-fg-3">Not answered yet</span>
                  <CaretDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
                </button>
              ) : (
                <Card
                  topicId={topicId}
                  card={card}
                  onGraded={() => setAnsweredKeys((current) => new Set(current).add(card.key))}
                  onNextPrompt={following ? () => openPrompt(following) : undefined}
                />
              )}
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button asChild variant={graded && complete ? 'primary' : 'link'} className={graded && complete ? undefined : 'max-sm:min-h-11'}>
          <Link href={onward.href} scroll={false}>
            <span className="inline-flex items-center gap-1.5">
              {onward.label}
              <ArrowRight className="size-4" />
            </span>
          </Link>
        </Button>
        {voiceHref ? (
          <Button asChild variant="ghost">
            <Link href={voiceHref} data-testid="do-it-out-loud">
              <span className="inline-flex items-center gap-1.5">
                <Microphone aria-hidden="true" className="size-4" />
                Do it out loud
              </span>
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export function Card({
  topicId,
  projectId: course,
  card,
  onGraded,
  onNextPrompt,
}: {
  topicId: string
  /** The course, outside the topic page (the map's teach-back); on it, the topic's own. */
  projectId?: string | null
  card: RecallCard
  onGraded: () => void
  /** Opens the next prompt without an answer, when there is one: the feedback ends in it as its one primary step. */
  onNextPrompt?: () => void
}) {
  const router = useRouter()
  const headingId = `recall-${card.key}`
  const checkHintId = React.useId()
  const stored = useStoredDraft(topicId, card.key)
  const topicCourse = useOptionalTopic()?.courseId ?? null
  const projectId = course ?? topicCourse
  // What is being written lives on the server (spec 18.7): it survives a closed tab and another device.
  const draft = useServerDraft<RecallDraftPayload>('recall', `${topicId}:${card.key}`, { projectId, topicId, parse: parseRecallPayload })
  const canDictate = useCanDictate()
  const [feedback, setFeedback] = React.useState<RecallFeedback | null>(card.latest)
  const [answering, setAnswering] = React.useState(card.latest === null)
  // What the student has typed since the page showed; until then the text is the stored draft.
  const [typed, setTyped] = React.useState<string | null>(null)
  const [voice, setVoice] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [clarify, setClarify] = React.useState<string | null>(null)
  const [listening, setListening] = React.useState(false)
  const recognizer = React.useRef<RecognitionLike | null>(null)
  const focus = useFocusRequest()
  const { blocked, report } = useAiStatus()

  // The student's own typing, else the saved draft, else an older draft from this tab.
  const text = typed ?? draft.value?.text ?? stored.text
  const textRef = React.useRef(text)
  React.useEffect(() => {
    textRef.current = text
  })
  const abandoned = stored.abandoned
  const draftVoice = draft.value?.voice ?? stored.voice

  // The card is open while its text box is shown: opening the reading from here on abandons it.
  React.useEffect(() => {
    const store = storage()
    if (answering && store) openDraft(store, topicId, card.key)
  }, [answering, topicId, card.key])

  const stopListening = React.useCallback(() => {
    recognizer.current?.stop()
    recognizer.current = null
    setListening(false)
  }, [])
  React.useEffect(() => stopListening, [stopListening])

  function change(value: string, dictated = false) {
    const next = value.slice(0, MAX_RECALL_ANSWER_CHARS)
    textRef.current = next
    setTyped(next)
    const spoken = dictated || voice || draftVoice
    if (next) draft.set({ text: next, voice: spoken })
    else void draft.clear()
    if (dictated) setVoice(true)
  }

  function toggleDictation() {
    if (listening) return stopListening()
    const Recognition = getRecognitionConstructor()
    if (!Recognition) return
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = languageTag(defaultLanguageCode(navigator.language))
    // What is said follows what is in the box at that moment, so words typed while talking are kept, not written over.
    let taken = 0
    recognition.onresult = (event) => {
      const fresh = newFinalWords(resultsFromEvent(event), taken)
      taken = fresh.taken
      if (fresh.words.length > 0) change([textRef.current.trim(), ...fresh.words].filter(Boolean).join(' '), true)
    }
    recognition.onerror = () => stopListening()
    recognition.onend = () => setListening(false)
    recognizer.current = recognition
    setListening(true)
    recognition.start()
  }

  /** Sends the answer, or "I don't remember" (spec 18.3): no text, and nothing for the grader to read. */
  async function send(idk: boolean) {
    const answer = idk ? '' : text.trim()
    if ((!answer && !idk) || busy) return
    stopListening()
    setBusy(true)
    setError(null)
    setClarify(null)
    try {
      const body = await apiFetch<Submitted>(`/api/topics/${topicId}/recall`, {
        method: 'POST',
        json: {
          kind: card.kind,
          ...(card.objectiveIndex !== null ? { objectiveIndex: card.objectiveIndex } : {}),
          ...(card.conceptId ? { conceptId: card.conceptId } : {}),
          answer,
          ...(idk ? { idk: true } : {}),
          abandoned,
          mode: !idk && (voice || draftVoice) ? 'voice' : 'text',
        },
      })
      if (body.status === 'ungraded') {
        // The text stays: the student adds to it.
        setClarify(body.clarifyingQuestion)
        return
      }
      const store = storage()
      if (store) clearDraft(store, topicId, card.key)
      await draft.clear()
      setFeedback(body.feedback)
      onGraded()
      setAnswering(false)
      setTyped(null)
      setVoice(false)
      // The text box is gone: the student lands on the feedback.
      focus.request('feedback')
      // The path ticks Recall and the next card moves on.
      React.startTransition(() => router.refresh())
    } catch (caught) {
      // The draft is saved already: the text is still in the box for another try.
      if (isApiError(caught)) report(caught.code)
      setError(isApiError(caught) ? caught.message : 'Your answer could not be graded. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const submit = () => send(false)
  const dontRemember = () => send(true)

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="text-body-strong text-fg">
        {card.prompt}
      </h3>
      {answering ? (
        <div className="mt-4">
          {abandoned ? (
            <InlineAlert className="mb-4" tone="neutral">
              You opened the reading while this was open, so this answer won&apos;t count toward your score.
            </InlineAlert>
          ) : null}
          <Textarea
            aria-labelledby={headingId}
            value={text}
            rows={5}
            maxRows={14}
            maxLength={MAX_RECALL_ANSWER_CHARS}
            placeholder="Write what you remember"
            ref={focus.register('answer')}
            invalid={error !== null}
            onChange={(event) => change(event.target.value)}
          />
          {clarify ? (
            <InlineAlert className="mt-4" tone="neutral" icon={<Question />} title="Not enough to grade yet">
              {clarify}
              <div className="mt-3">
                <Button variant="secondary" data-testid="recall-idk" onClick={() => void dontRemember()} loading={busy}>
                  I don&apos;t remember
                </Button>
              </div>
            </InlineAlert>
          ) : null}
          {error ? (
            <InlineAlert className="mt-4" tone="danger">
              {error} Your answer is still here.
            </InlineAlert>
          ) : null}
          <AiBlockedNote className="mt-4" />
          {text.trim() ? null : (
            <p id={checkHintId} className="mt-3 text-small text-fg-2">
              Write a few words to check your answer, or say you don&apos;t remember.
            </p>
          )}
          {text.trim() && statusLabel(draft.status) ? <p className="mt-3 text-caption text-fg-3">{statusLabel(draft.status)}</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!text.trim() || !!blocked} disabledReason={blocked ? 'AI is unavailable right now, so answers cannot be checked.' : 'Write a few words first.'}>
              Check my answer
            </Button>
            {clarify ? null : (
              <Button variant="secondary" data-testid="recall-idk" onClick={() => void dontRemember()} loading={busy}>
                I don&apos;t remember
              </Button>
            )}
            {canDictate ? (
              <Button variant="secondary" icon={listening ? <MicrophoneSlash /> : <Microphone />} aria-pressed={listening} onClick={toggleDictation}>
                {listening ? 'Stop dictating' : 'Dictate'}
              </Button>
            ) : null}
            {feedback ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setAnswering(false)
                  focus.request('feedback')
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : feedback ? (
        <FeedbackView
          topicId={topicId}
          feedback={feedback}
          onFeedback={setFeedback}
          regionRef={focus.register('feedback')}
          onNextPrompt={onNextPrompt}
          onAgain={() => {
            setClarify(null)
            setError(null)
            setAnswering(true)
            focus.request('answer')
          }}
        />
      ) : null}
    </section>
  )
}

function FeedbackView({
  topicId,
  feedback,
  onFeedback,
  onAgain,
  onNextPrompt,
  regionRef,
}: {
  topicId: string
  feedback: RecallFeedback
  onFeedback: (feedback: RecallFeedback) => void
  onAgain: () => void
  onNextPrompt?: () => void
  regionRef: (element: HTMLElement | null) => void
}) {
  const [revealing, setRevealing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const moreId = React.useId()
  const complete = !feedback.idk && feedback.wrong.length === 0 && feedback.missed.length === 0
  // Help on request: the explanation, an easier step and "Show me what I missed" wait behind "More help" until it is asked for.
  const hasHelpLinks = !!feedback.help && (!!feedback.help.explainer || !!feedback.help.easierStep)
  const showMoreHelp = !complete && (hasHelpLinks || feedback.revealed === null)

  async function reveal() {
    if (revealing) return
    setRevealing(true)
    setError(null)
    try {
      const { revealed } = await apiFetch<{ revealed: RevealedClaim[] }>(`/api/topics/${topicId}/recall`, { method: 'PATCH', json: { attemptId: feedback.attemptId } })
      onFeedback({ ...feedback, revealed })
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not show that. Try again.')
    } finally {
      setRevealing(false)
    }
  }

  return (
    <div ref={regionRef} role="region" aria-label="Feedback on your answer" className="mt-4 flex flex-col gap-6 outline-none">
      {feedback.abandoned ? (
        <InlineAlert tone="neutral">This answer didn&apos;t count toward your score, because the reading was open.</InlineAlert>
      ) : null}
      {!feedback.abandoned && feedback.repeat ? (
        <InlineAlert tone="neutral">
          {feedback.repeat === 'revealed'
            ? "This answer didn't count toward your score, because you had seen what you missed. Try again tomorrow."
            : "This was a second try after seeing feedback, so it counts as practice, not a fresh recall. Try again tomorrow."}
        </InlineAlert>
      ) : null}
      {feedback.got.length > 0 ? (
        <div>
          <h4 className="flex items-center gap-2 text-body-strong text-fg">
            <CheckCircle aria-hidden="true" weight="fill" className="size-4 text-accent" />
            What you got
          </h4>
          <ul className="mt-2 flex flex-col gap-2.5">
            {feedback.got.map((item, index) => (
              <li key={index} className="text-small text-fg-2">
                <span className="block text-caption text-fg-3">
                  {item.conceptName}
                  {item.partial ? ' (part of it)' : ''}
                </span>
                <p>
                  You wrote <span className="text-fg">“{item.quote}”</span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {feedback.wrong.length > 0 ? (
        <div>
          <h4 className="flex items-center gap-2 text-body-strong text-fg">
            <MinusCircle aria-hidden="true" weight="fill" className="size-4 text-warning" />
            What is not right
          </h4>
          <ul className="mt-2 flex flex-col gap-3">
            {feedback.wrong.map((item, index) => (
              <li key={index} className="text-small text-fg-2">
                <span className="block text-caption text-fg-3">{item.conceptName}</span>
                {item.studentQuote ? (
                  <p>
                    You wrote <span className="text-fg">“{item.studentQuote}”</span>
                  </p>
                ) : null}
                <p>
                  Your pages say <span className="text-fg">“<LazyMarkdownInline>{quoteOnOneLine(item.sourceQuote)}</LazyMarkdownInline>”</span>
                  {item.page !== null ? <span className="text-fg-3"> (p. {item.page})</span> : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {feedback.idk ? (
        <div>
          <h4 className="flex items-center gap-2 text-body-strong text-fg">
            <MinusCircle aria-hidden="true" weight="fill" className="size-4 text-warning" />
            Where to look
          </h4>
          <div aria-live="polite" className="mt-2">
            <ExpectedMiss surface="recall_idk" />
          </div>
          <PointerList help={feedback.help} className="mt-3" />
        </div>
      ) : null}
      {!feedback.idk && feedback.missed.length > 0 ? (
        <div>
          <h4 className="flex items-center gap-2 text-body-strong text-fg">
            <MinusCircle aria-hidden="true" weight="fill" className="size-4 text-warning" />
            What you missed
          </h4>
          <div aria-live="polite" className="mt-2">
            <ExpectedMiss surface="recall_gaps" />
          </div>
          <ul className="mt-2 flex flex-col gap-2.5">
            {feedback.missed.map((item) => {
              const pointer = feedback.help?.pointers.find((candidate) => candidate.conceptName === item.conceptName)
              return (
                <li key={item.claimId} className="text-small text-fg-2">
                  <span className="block text-caption text-fg-3">{item.conceptName}</span>
                  {pointer ? <PointerLink pointer={pointer} label={item.pointer} /> : <p>{item.pointer}</p>}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {complete ? <InlineAlert tone="accent">You covered every idea this question asks about.</InlineAlert> : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {feedback.revealed ? (
        <div>
          <h4 className="text-body-strong text-fg">What your pages say</h4>
          <ul className="mt-2 flex flex-col gap-3">
            {feedback.revealed.map((item) => (
              <li key={item.claimId} className="text-small text-fg-2">
                <span className="block text-caption text-fg-3">
                  {item.conceptName}
                  {item.page !== null ? ` (p. ${item.page})` : ''}
                </span>
                <p className="text-fg">{item.text}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-caption text-fg-3">Seeing these is recorded as help, so it doesn&apos;t add to your score.</p>
        </div>
      ) : null}
      {/* One primary step ends the feedback: the next prompt when there is one (or, on the last, the way on below the prompts). Answering this one again is the quiet choice beside it; the extra help is behind one disclosure. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {onNextPrompt ? (
          <Button variant="primary" icon={<ArrowRight />} onClick={onNextPrompt}>
            Answer the next prompt
          </Button>
        ) : null}
        <Button variant="link" className="max-sm:min-h-11" onClick={onAgain}>
          Answer again
        </Button>
      </div>
      {showMoreHelp ? (
        <div className="-mt-3">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            icon={<Question />}
            className="-ml-2.5 max-sm:min-h-11"
            onClick={() => setMoreOpen((current) => !current)}
          >
            <span className="inline-flex items-center gap-1">
              More help
              <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', moreOpen && 'rotate-180')} />
            </span>
          </Button>
          <div id={moreId} hidden={!moreOpen} className="mt-2 flex flex-col items-start gap-2">
            <HelpLinks help={feedback.help} />
            {feedback.revealed === null ? (
              <Button variant="ghost" size="sm" icon={<Eye />} className="-ml-2.5 max-sm:min-h-11" loading={revealing} onClick={() => void reveal()}>
                Show me what I missed
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

type Pointer = HelpAfterMiss['pointers'][number]

const HELP_LINK = 'inline-flex min-h-8 items-center rounded-chip text-small text-accent underline underline-offset-2 hover:text-accent-hover max-sm:min-h-11'

/** "Look again at p. 5": a real link to the reader at the idea's first passage; opening it records the instruction (spec 18.5). */
function PointerLink({ pointer, label }: { pointer: Pointer; label?: string }) {
  return (
    <Link
      href={pointer.href}
      data-testid="recall-pointer"
      className={cn('mt-1 gap-1', HELP_LINK)}
    >
      {label ?? (pointer.page !== null ? `Look again at p. ${pointer.page}` : `Look again at ${pointer.conceptName}`)}
    </Link>
  )
}

/** One line per idea the answer left out, each a link to its passage. */
function PointerList({ help, className }: { help: HelpAfterMiss | null; className?: string }) {
  if (!help || help.pointers.length === 0) return null
  return (
    <ul className={cn('flex flex-col gap-2.5', className)}>
      {help.pointers.map((pointer) => (
        <li key={pointer.conceptId} className="text-small text-fg-2">
          <span className="block text-caption text-fg-3">{pointer.conceptName}</span>
          <div>
            <PointerLink pointer={pointer} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The explanation, and an easier step where the idea has failed before (spec 18.3). */
function HelpLinks({ help, className }: { help: HelpAfterMiss | null; className?: string }) {
  if (!help || (!help.explainer && !help.easierStep)) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {help.explainer ? (
        <Link href={help.explainer.href} data-testid="recall-explainer-link" className={HELP_LINK}>
          {help.explainer.ready ? 'Read the explanation' : 'Open the explanation'}
        </Link>
      ) : null}
      {help.easierStep ? (
        <Link href={help.easierStep.href} className={HELP_LINK}>
          {help.easierStep.label}
        </Link>
      ) : null}
    </div>
  )
}
