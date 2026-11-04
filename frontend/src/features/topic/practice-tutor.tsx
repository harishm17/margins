'use client'

import * as React from 'react'
import { BookOpenText, ChatCircleText, Question } from '@phosphor-icons/react/dist/ssr'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { Textarea } from '@/components/ui/textarea'
import { aiMessage, isKnownAiCode, type AiMessage } from '@/lib/ai/messages'
import { fillResetTime } from '@/lib/budget/copy'
import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import type { PracticeTutorBody, PracticeTutorResponse, PracticeTutorState } from '@/lib/tutor/practice-api'
import type { MissKind } from '@/lib/tutor/state'
import { HINT_COST_COPY } from './practice-state'

/**
 * "Ask about my working" on a practice step (spec §5.6, §6.2): the tutor panel under the step, its
 * state, and the one-time offer to talk it through. The browser checks answers; the server keeps the
 * ladder and what it saw of the checks (POST /api/topics/[topicId]/practice-tutor), and every
 * submission is one event there.
 */

export type StepTutorConfig = {
  topicId: string
  problemIndex: number
  problemTitle: string
  stepIndex: number
  /** The step's key in the practice progress; the offer is remembered under it. */
  stepKey: string
}

type Turn = { id: number; who: 'you' | 'tutor' | 'worked'; text: string }
type Pending = 'ask' | 'clarify' | 'show_worked' | null
/** Why a request failed, by the code the server sent (never by the words). */
type FailureKind = 'not_allowed' | 'stale' | 'busy' | 'other'
type Failure = { message: AiMessage; kind: FailureKind }

const MAX_WORKING_CHARS = 4000
const offerKey = (stepKey: string) => `margins:tutor-offer:${stepKey}`

function offerAnswered(stepKey: string): boolean {
  try {
    return window.localStorage.getItem(offerKey(stepKey)) === '1'
  } catch {
    return false
  }
}

function rememberOffer(stepKey: string) {
  try {
    window.localStorage.setItem(offerKey(stepKey), '1')
  } catch {
    // Private mode: the offer can come back after a reload, which does no harm.
  }
}

const neutral = (title: string, text: string): AiMessage => ({ title, text, tone: 'neutral', retry: false })

/**
 * What the student reads when the tutor did not answer, chosen by the code and the status. Only a server
 * failure or a limit means "the AI is busy" (and tells the shared AI status); a request the server did
 * not accept is a plain message. Nothing the service wrote is shown.
 */
function failureOf(status: number, code: string | null): { failure: Failure; reportCode: string | null } {
  if (code === 'STALE_PRACTICE') return { failure: { kind: 'stale', message: neutral('This practice changed', 'This practice was updated. Reload the page to continue.') }, reportCode: null }
  if (code === 'NOT_ALLOWED' || code === 'ATTEMPT_FIRST') return { failure: { kind: 'not_allowed', message: neutral('Not yet', "Check an answer first, or say you don't know, then try again.") }, reportCode: null }
  if (code === 'RATE_LIMITED' || (status === 429 && !isKnownAiCode(code))) {
    return {
      failure: { kind: 'busy', message: { title: 'Slow down a little', text: 'You are asking quickly. Wait a moment, then try again.', tone: 'warning', retry: true } },
      reportCode: null,
    }
  }
  if (status >= 500 || status === 429 || status === 0) {
    const known = code && isKnownAiCode(code) ? code : 'LLM_UNAVAILABLE'
    const message = aiMessage(known)
    return { failure: { kind: 'busy', message: { ...message, text: fillResetTime(message.text) } }, reportCode: code }
  }
  return { failure: { kind: 'other', message: neutral('The tutor could not take that', 'The tutor could not take that request. The hints and the checks still work.') }, reportCode: null }
}

type Outcome = { ok: true; body: PracticeTutorResponse } | { ok: false; failure: Failure; reportCode: string | null }

async function post(topicId: string, body: PracticeTutorBody): Promise<Outcome> {
  try {
    const response = await fetch(`/api/topics/${topicId}/practice-tutor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true, body: (await response.json()) as PracticeTutorResponse }
    const payload = (await response.json().catch(() => null)) as { error?: { details?: { code?: unknown } } } | null
    const code = typeof payload?.error?.details?.code === 'string' ? payload.error.details.code : null
    return { ok: false, ...failureOf(response.status, code) }
  } catch {
    return { ok: false, ...failureOf(0, 'AI_UNREACHABLE') }
  }
}

type StepRead = { state: PracticeTutorState; contentId: string; help?: HelpAfterMiss }

async function readState(config: StepTutorConfig): Promise<StepRead | null> {
  try {
    const query = new URLSearchParams({ problemIndex: String(config.problemIndex), problemTitle: config.problemTitle, stepIndex: String(config.stepIndex) })
    const response = await fetch(`/api/topics/${config.topicId}/practice-tutor?${query}`)
    return response.ok ? ((await response.json()) as StepRead) : null
  } catch {
    return null
  }
}

/**
 * The tutor for one step: the conversation, what the server has seen of the checks (so a reload loses
 * nothing), whether the worked example may be used, and the one-time offer. `onHelp` is told the rung a
 * reply gave, so the step is recorded at the level of the help it took.
 */
export function useStepTutor(config: StepTutorConfig, options: { onHelp: (rung: number) => void }) {
  const { blocked, report } = useAiStatus()
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [pending, setPending] = React.useState<Pending>(null)
  const [failure, setFailure] = React.useState<Failure | null>(null)
  const [checks, setChecks] = React.useState<{ answer: string; correct: boolean }[]>([])
  const [sent, setSent] = React.useState<string[]>([])
  const [server, setServer] = React.useState<PracticeTutorState | null>(null)
  // What to read after a miss (spec 18.3), the content row the step belongs to (the draft's key), and the I don't know button.
  const [help, setHelp] = React.useState<HelpAfterMiss | null>(null)
  const [contentId, setContentId] = React.useState<string | null>(null)
  const [idkPressed, setIdkPressed] = React.useState(false)
  const [answered, setAnswered] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const missKind = React.useRef<MissKind | undefined>(undefined)
  const nextId = React.useRef(0)
  // The server keeps the step's ladder: its events are sent one after another, in the order the student made them, so a check is
  // recorded before the question that follows it and an older reply never lands over a newer one.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())
  const inOrder = React.useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task)
    queue.current = run.catch(() => undefined)
    return run
  }, [])
  const { topicId, problemIndex, problemTitle, stepIndex, stepKey } = config

  const base = React.useMemo(() => ({ problemIndex, problemTitle, stepIndex }), [problemIndex, problemTitle, stepIndex])
  const attempts = checks.map((check) => check.answer)

  // Where the conversation stood when the page opened: the server's count of checks, not the browser's.
  React.useEffect(() => {
    let live = true
    void readState({ topicId, problemIndex, problemTitle, stepIndex, stepKey }).then((read) => {
      if (!live || !read) return
      setServer((current) => current ?? read.state)
      setContentId(read.contentId)
      if (read.help) setHelp((current) => current ?? read.help ?? null)
    })
    return () => {
      live = false
    }
  }, [topicId, problemIndex, problemTitle, stepIndex, stepKey])

  const addTurn = React.useCallback((who: Turn['who'], text: string) => {
    setTurns((current) => [...current, { id: nextId.current++, who, text }])
  }, [])

  const learn = React.useCallback(
    (state: PracticeTutorState) => {
      setServer(state)
      // The tutor may mention the button once, on the third failed attempt (spec 6.2); with no AI there is no button to point at.
      if (state.offerWorked && !blocked) addTurn('tutor', 'If it would help, you can ask for a worked example of a similar problem with the button below.')
    },
    [addTurn, blocked]
  )

  /** A checked answer: one event on the ladder, no model call. */
  const noteCheck = React.useCallback(
    (answer: string, correct: boolean) => {
      setChecks((current) => [...current, { answer, correct }])
      void inOrder(() => post(topicId, { ...base, event: 'check', answer })).then((outcome) => {
        if (!outcome.ok) return
        // A later success clears an old failure message.
        setFailure(null)
        learn(outcome.body.state)
        if (outcome.body.help) setHelp(outcome.body.help)
      })
    },
    [topicId, base, learn, inOrder]
  )

  /** "I don't know": the step's first check, wrong (spec 18.3). No model call. */
  const noteDontKnow = React.useCallback(() => {
    setIdkPressed(true)
    void inOrder(() => post(topicId, { ...base, event: 'dont_know' })).then((outcome) => {
      if (!outcome.ok) return
      setFailure(null)
      learn(outcome.body.state)
      if (outcome.body.help) setHelp(outcome.body.help)
    })
  }, [topicId, base, learn, inOrder])

  /** "Show answer": the same surrender as a delivered worked example (spec 18.4). No model call. */
  const noteReveal = React.useCallback(() => {
    void inOrder(() => post(topicId, { ...base, event: 'reveal' })).then((outcome) => {
      if (outcome.ok) learn(outcome.body.state)
    })
  }, [topicId, base, learn, inOrder])

  /** An authored hint was opened (0 locate, 1 connect, 2 structure). */
  const noteHint = React.useCallback(
    (index: 0 | 1 | 2) => {
      void inOrder(() => post(topicId, { ...base, event: 'hint', hintIndex: index }))
    },
    [topicId, base, inOrder]
  )

  async function call(event: 'ask' | 'clarify' | 'show_worked', draft: string, message?: string): Promise<boolean> {
    setPending(event)
    setFailure(null)
    // The tutor reads everything the student has written about the step; only `message` is the event.
    const working = [...sent, draft].filter((part) => part.trim()).join('\n').slice(-MAX_WORKING_CHARS)
    const outcome = await inOrder(() =>
      post(topicId, {
        ...base,
        event,
        working,
        ...(message !== undefined ? { message } : {}),
        attempts,
        ...(missKind.current ? { missKind: missKind.current } : {}),
      })
    )
    setPending(null)
    if (!outcome.ok) {
      report(outcome.reportCode)
      setFailure(outcome.failure)
      // The server's record is the truth about what is allowed: read it again.
      if (outcome.failure.kind === 'not_allowed') void readState(config).then((read) => read && setServer(read.state))
      return false
    }
    const { reply, state, surrendered } = outcome.body
    if (event === 'ask' && message) {
      addTurn('you', message)
      setSent((current) => [...current, message])
    }
    if (reply) {
      addTurn(surrendered ? 'worked' : 'tutor', reply.text)
      missKind.current = reply.missKind ?? undefined
    }
    // A reply that gave more than orient is help: the step is recorded at its level (spec 6.2). Once.
    const help = surrendered ? 5 : reply && reply.rungUsed >= 1 ? reply.rungUsed : 0
    if (help > 0) options.onHelp(help)
    learn(state)
    return true
  }

  const wrongChecks = Math.max(server?.wrongChecks ?? 0, checks.filter((check) => !check.correct).length)
  const checked = Math.max(server?.checks ?? 0, checks.length) >= 1 || idkPressed
  const workedAllowed = (server?.workedAllowed ?? false) || wrongChecks >= 1 || idkPressed
  const offerVisible = wrongChecks >= 2 && !blocked && !answered && turns.length === 0 && !offerAnswered(stepKey)
  const answerOffer = () => {
    rememberOffer(stepKey)
    setAnswered(true)
  }

  return {
    turns,
    pending,
    failure,
    blocked,
    checked,
    workedAllowed,
    offerVisible,
    confirming,
    help,
    contentId,
    /** The checks the server has seen on the step, and whether "I don't know" was among them. */
    checks: Math.max(server?.checks ?? 0, checks.length + (idkPressed ? 1 : 0)),
    wrongChecks: wrongChecks + (idkPressed && !(server?.dontKnow) ? 1 : 0),
    dontKnow: (server?.dontKnow ?? false) || idkPressed,
    noteCheck,
    noteDontKnow,
    noteReveal,
    noteHint,
    /** "Ask about my working": `message` is what they just wrote. */
    ask: (message: string) => call('ask', message, message.trim()),
    clarify: (draft: string) => call('clarify', draft),
    showWorked: (draft: string) => call('show_worked', draft),
    /** "Yes, talk it through": the tutor opens by asking what they tried. */
    acceptOffer: (draft: string) => {
      answerOffer()
      return call('ask', draft, '')
    },
    dismissOffer: answerOffer,
    /** "Check my understanding" on a solved step: the tutor asks one transfer question (spec 6.2, confirm). */
    startConfirm: async () => {
      const ok = await call('ask', '', '')
      if (ok) setConfirming(true)
      return ok
    },
  }
}

export type StepTutor = ReturnType<typeof useStepTutor>

const WHO: Record<Turn['who'], string> = { you: 'You', tutor: 'Tutor', worked: 'Worked example' }

/** The conversation so far. A live region, so a new reply is announced. */
export function TutorThread({ turns, pending }: Pick<StepTutor, 'turns' | 'pending'>) {
  if (turns.length === 0 && !pending) return null
  return (
    <div role="log" aria-label="Tutor conversation" className="flex flex-col gap-3 rounded-control border border-border bg-surface px-3.5 py-3">
      {turns.map((turn) => (
        <div key={turn.id} className="flex flex-col gap-0.5">
          <p className="text-caption font-medium text-fg-3">{WHO[turn.who]}</p>
          {turn.who === 'you' ? (
            <p className="whitespace-pre-wrap text-small text-fg">{turn.text}</p>
          ) : (
            <LazyMarkdown variant="compact" className="text-small! text-fg!">
              {turn.text}
            </LazyMarkdown>
          )}
        </div>
      ))}
      {pending ? (
        <p className="text-small text-fg-3">{pending === 'show_worked' ? 'Working out an example…' : 'Thinking…'}</p>
      ) : null}
    </div>
  )
}

/** After two wrong checks, once: the student decides whether to talk it through. */
export function TalkOffer({ tutor, working }: { tutor: StepTutor; working: string }) {
  if (!tutor.offerVisible) return null
  return (
    <InlineAlert icon={<ChatCircleText />} title="Want to talk it through?">
      <p>You can keep trying on your own, or the tutor can ask about your working.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => void tutor.acceptOffer(working)}>
          Yes, talk it through
        </Button>
        <Button size="sm" variant="ghost" onClick={tutor.dismissOffer}>
          Not now
        </Button>
      </div>
    </InlineAlert>
  )
}

function FailureNote({ tutor }: { tutor: StepTutor }) {
  if (!tutor.failure) return null
  const { message } = tutor.failure
  return (
    <InlineAlert tone={message.tone === 'danger' ? 'danger' : message.tone === 'warning' ? 'warning' : 'neutral'} title={message.title}>
      {message.text}
    </InlineAlert>
  )
}

/** The line under the worked-example button: what it costs (the hint-cost labels of the help policy) and that it comes back. */
function workedCostNote(failedFirstTry: boolean): string {
  const cost = failedFirstTry ? HINT_COST_COPY.no_extra_cost : HINT_COST_COPY.counts_as_miss
  const sentence = cost[0].toUpperCase() + cost.slice(1)
  return failedFirstTry ? sentence : `${sentence}, and comes back later`
}

/**
 * The tutor actions in the step's help. They are hidden while AI is unavailable (the hints and checks still work), and a
 * failed request leaves a visible message and changes nothing else. "What is this asking?" is free and always there; asking
 * about the working and the worked example wait for one checked answer (effort first, spec 5.6), and are not drawn as a
 * wall of disabled buttons before it: one sentence says what opens, and when.
 */
export function TutorActions({
  tutor,
  working,
  onSent,
  failedFirstTry,
}: {
  tutor: StepTutor
  working: string
  onSent: () => void
  /** The step is already a failed first try (an I don't know, Connect, a second check): more help costs nothing more. */
  failedFirstTry: boolean
}) {
  const askNoteId = React.useId()
  const busy = tutor.pending !== null
  if (tutor.blocked) return <AiBlockedNote />
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Ask the tutor" className="flex flex-wrap gap-2">
        {tutor.checked ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<ChatCircleText />}
            aria-describedby={askNoteId}
            disabled={!working.trim() || busy}
            className="max-sm:min-h-11"
            onClick={() => void tutor.ask(working).then((ok) => ok && onSent())}
          >
            Ask about my working
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" icon={<Question />} disabled={busy} className="max-sm:min-h-11" onClick={() => void tutor.clarify(working)}>
          What is this asking?
        </Button>
        {tutor.workedAllowed ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<BookOpenText />}
            disabled={busy}
            className="h-auto max-w-full shrink items-start py-1.5 text-left max-sm:h-auto max-sm:min-h-11"
            onClick={() => void tutor.showWorked(working)}
          >
            <span className="flex flex-col whitespace-normal">
              <span>Show me a worked example</span>
              <span className="text-caption font-normal text-fg-2">{workedCostNote(failedFirstTry)}</span>
            </span>
          </Button>
        ) : null}
      </div>
      <p id={askNoteId} className="text-caption text-fg-3">
        {tutor.checked
          ? failedFirstTry
            ? 'Asking what a step means is free. More help costs nothing extra: this step already counts as a miss.'
            : `Asking what a step means is free. If the tutor names the idea, ${HINT_COST_COPY.counts_as_miss}.`
          : "Asking what a step means is free. Check an answer first, or say you don't know, to open the later hints, a worked example and questions about your working."}
      </p>
      <FailureNote tutor={tutor} />
    </div>
  )
}

/**
 * Under a step that was solved with help: one action to check understanding. The tutor asks a single
 * transfer question; the student answers it here and the tutor replies to the answer. Nothing is graded
 * or recorded beyond the step itself.
 */
export function ConfirmPanel({ tutor }: { tutor: StepTutor }) {
  const [reply, setReply] = React.useState('')
  const replyId = React.useId()
  if (tutor.blocked) return null
  const busy = tutor.pending !== null
  return (
    <div className="flex flex-col gap-3">
      <TutorThread turns={tutor.turns} pending={tutor.pending} />
      {tutor.confirming ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={replyId} className="text-small text-fg-2">
            Your answer to the question
          </label>
          <Textarea id={replyId} rows={2} value={reply} onChange={(event) => setReply(event.target.value)} />
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!reply.trim() || busy}
              onClick={() => void tutor.ask(reply).then((ok) => ok && setReply(''))}
            >
              Send answer
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="secondary" icon={<ChatCircleText />} disabled={busy} onClick={() => void tutor.startConfirm()}>
            Check my understanding
          </Button>
        </div>
      )}
      <FailureNote tutor={tutor} />
    </div>
  )
}
