'use client'

import * as React from 'react'
import { ArrowUp, Stop } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Select, type SelectOption } from '@/components/ui/select'
import { MAX_QUESTION_CHARS } from '@/lib/ask/explain'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'

export { MAX_QUESTION_CHARS }
const COUNT_FROM = 1800
const MAX_ROWS = 8
const LINE = 24

export const ALL_MATERIALS = 'all'

type ComposerProps = {
  /** `requestId` names this send; the draft keeps it until the server has the question, so a reload can find out what happened. */
  onSend: (question: string, requestId: string) => void
  onStop: () => void
  sending: boolean
  /** Topics to scope an answer to. Omit with `fixedScope` when the scope is set by the page. */
  scopeOptions?: SelectOption[]
  scope?: string
  onScopeChange?: (scope: string) => void
  /** A label shown instead of the select, e.g. the topic of the sheet. */
  fixedScope?: string
  disabled?: boolean
  autoFocus?: boolean
  /** Text the box starts with (not sent). The cursor goes to its end. */
  initialValue?: string
  /**
   * Where the unsent question is kept (spec 18.7): the course and the conversation (`<courseId>:<threadId>`, or `new` before the
   * first message). A reload, a closed tab or another device brings it back. Omit to keep nothing.
   */
  draft?: { courseId: string; key: string }
  /** Hears, as it happens, that the server accepted a question; the draft is cleared then and not before. */
  subscribeAccepted?: (listener: (question: string) => void) => () => void
  /** Hears that a send failed before the server kept the question: the saved text is then plainly unsent. */
  subscribeRejected?: (listener: (question: string) => void) => () => void
  /** The conversation already has a reply: the box invites an answer or a follow-up instead of a first question. */
  hasMessages?: boolean
  /** Text to put in the box now (a failed question sent back by "Edit question"). A new `nonce` puts it there again. */
  edit?: { text: string; nonce: number } | null
  /** A question sent just before a reload turned out to have been accepted: open the conversation it started. */
  onRecovered?: (threadId: string, title: string | null) => void
}

/** How long after a send a missing question may still be on its way to the server before the text is given back as unsent. */
const SEND_GRACE_MS = 10_000
const RECHECK_MS = 2500

type AskDraft = { text: string; sending?: string; sentAt?: number }

const parseAskDraft = (raw: unknown): AskDraft | null => {
  const entry = raw as Partial<AskDraft> | null
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || entry.text === '') return null
  return {
    text: entry.text,
    ...(typeof entry.sending === 'string' ? { sending: entry.sending } : {}),
    ...(typeof entry.sentAt === 'number' ? { sentAt: entry.sentAt } : {}),
  }
}

/** Auto-growing question box with the scope and the send or stop button inside one frame. */
export function Composer({
  onSend,
  onStop,
  sending,
  scopeOptions,
  scope = ALL_MATERIALS,
  onScopeChange,
  fixedScope,
  disabled,
  autoFocus,
  initialValue = '',
  draft: draftAt,
  subscribeAccepted,
  subscribeRejected,
  hasMessages = false,
  edit = null,
  onRecovered,
}: ComposerProps) {
  const draft = useServerDraft<AskDraft>('ask', draftAt ? `${draftAt.courseId}:${draftAt.key}` : null, {
    projectId: draftAt?.courseId ?? null,
    parse: parseAskDraft,
  })
  // What was typed since the box showed; until then, a link's prefill, else the saved draft.
  // It belongs to one conversation: another conversation shows its own draft.
  const draftKey = draftAt ? `${draftAt.courseId}:${draftAt.key}` : null
  const [typedState, setTypedState] = React.useState<{ key: string | null; text: string | null }>({ key: draftKey, text: initialValue || null })
  const typed = typedState.key === draftKey ? typedState.text : null
  const setTyped = (text: string) => setTypedState({ key: draftKey, text })
  // A draft with a send marker was handed to the server before a reload: it is not an unsent question until the server says it never got it.
  const pendingSend = typed === null ? (draft.value?.sending ?? null) : null
  const value = typed ?? (pendingSend ? '' : (draft.value?.text ?? ''))
  // The box was filled from a saved draft (a reload, another device, a send that never got an answer), not typed or prefilled
  // here: say so, quietly, until the student changes it.
  const restored = typed === null && !pendingSend && !!draft.value?.text && !disabled
  const setValue = (next: string) => {
    setTyped(next)
    if (next.trim()) draft.set({ text: next })
    else void draft.clear()
  }
  // Sending empties the box but not the draft: it goes only when the server has accepted the question, so a failed send,
  // a closed tab or a reload in between still has the text.
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  })
  const clearDraft = draft.clear
  React.useEffect(() => {
    if (!subscribeAccepted) return
    // Not while the student is already typing the next question: that is the draft now.
    return subscribeAccepted(() => {
      if (valueRef.current.trim() === '') void clearDraft()
    })
  }, [subscribeAccepted, clearDraft])
  const ref = React.useRef<HTMLTextAreaElement>(null)

  // After a reload with a send marker in the draft: did the server get that question? If it did, open its conversation and drop the
  // draft; if not, and the send is old enough to be lost, give the text back as unsent. Until then the box says it is checking.
  const checking = pendingSend !== null && !sending
  const draftText = draft.value?.text ?? ''
  const sentAt = draft.value?.sentAt ?? 0
  const draftRef = React.useRef(draft)
  React.useEffect(() => {
    draftRef.current = draft
  })
  // A send that failed in front of the student: its text stays as an ordinary draft, so a reload gives it back at once.
  React.useEffect(() => {
    if (!subscribeRejected) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeRejected(() => {
      // A page that is being reloaded fails its open request too, and that is not a refusal: the timer dies with the page, so only a
      // failure the student is still looking at changes the draft.
      timer = setTimeout(() => {
        const held = draftRef.current.value
        if (held?.sending) draftRef.current.set({ text: held.text })
      }, 400)
    })
    return () => {
      stop()
      if (timer) clearTimeout(timer)
    }
  }, [subscribeRejected])

  const recoveredRef = React.useRef(onRecovered)
  React.useEffect(() => {
    recoveredRef.current = onRecovered
  })
  const courseId = draftAt?.courseId
  React.useEffect(() => {
    if (!pendingSend || sending || !courseId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      let found: { id: string; title: string | null } | null | undefined
      try {
        const data = await apiFetch<{ thread: { id: string; title: string | null } | null }>(
          `/api/projects/${encodeURIComponent(courseId)}/chat/threads?requestId=${encodeURIComponent(pendingSend)}`
        )
        found = data.thread
      } catch {
        found = undefined
      }
      if (cancelled) return
      if (found) {
        // Open the conversation first; dropping the draft may have to wait for a save that is still out.
        recoveredRef.current?.(found.id, found.title)
        void draftRef.current.clear()
        return
      }
      const age = Date.now() - sentAt
      // The server said no after the grace, or could not be asked for long enough: the question never arrived, so it is unsent.
      if ((found === null && age >= SEND_GRACE_MS) || age >= SEND_GRACE_MS * 3) {
        draftRef.current.set({ text: draftText })
        return
      }
      timer = setTimeout(check, RECHECK_MS)
    }
    void check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pendingSend, sending, courseId, sentAt, draftText])

  // "Edit question": the failed question comes back into the box.
  const editNonce = edit?.nonce ?? 0
  const editText = edit?.text ?? ''
  const appliedEdit = React.useRef(0)
  React.useEffect(() => {
    if (!editNonce || appliedEdit.current === editNonce) return
    appliedEdit.current = editNonce
    setTyped(editText)
    if (editText.trim()) draftRef.current.set({ text: editText })
    const el = ref.current
    if (el) {
      el.focus()
      el.setSelectionRange(editText.length, editText.length)
    }
    // setTyped only reads the draft key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editNonce, editText])

  const resize = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const max = MAX_ROWS * LINE
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [])

  React.useLayoutEffect(resize, [resize, value])

  React.useEffect(() => {
    const el = ref.current
    if (!autoFocus || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [autoFocus])

  const trimmed = value.trim()
  // While AI is unavailable or the allowance is used the question can still be typed; sending is
  // off, and the line under the box says why.
  const { blocked } = useAiStatus()
  const canSend = trimmed.length > 0 && !sending && !disabled && !blocked

  const submit = () => {
    if (!canSend) return
    const requestId = crypto.randomUUID()
    // The marker goes into the draft first: a reload before the server answers finds out whether it got this question.
    if (draftAt) draft.set({ text: trimmed, sending: requestId, sentAt: Date.now() })
    onSend(trimmed, requestId)
    setTyped('')
    valueRef.current = ''
  }

  return (
    <form
      data-ask-composer=""
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className={cn(
        'rounded-card border border-control bg-surface p-2 transition-[border-color,box-shadow] duration-120',
        'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25'
      )}
    >
      <label htmlFor="ask-composer" className="sr-only">
        Ask about your materials
      </label>
      <textarea
        id="ask-composer"
        ref={ref}
        rows={1}
        value={value}
        maxLength={MAX_QUESTION_CHARS}
        disabled={disabled}
        placeholder={hasMessages ? 'Write your answer or ask a follow-up...' : 'Ask about your materials...'}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape' && sending) {
            event.preventDefault()
            onStop()
          }
        }}
        className="block max-h-48 w-full resize-none max-sm:min-h-11 bg-transparent px-2 py-1 text-[15px] max-sm:text-[16px] leading-6 text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed"
        style={{ height: LINE + 8 }}
      />
      {checking ? (
        <p role="status" className="px-2 pb-0.5 text-caption font-normal text-fg-3" data-testid="ask-checking">
          Checking whether your question was sent...
        </p>
      ) : null}
      {restored ? (
        <p role="status" className="px-2 pb-0.5 text-caption font-normal text-fg-3" data-testid="ask-restored">
          Your unsent question was restored.
        </p>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {/* The scope says what the question is about, not a filter on the conversation: the words are on screen, not only in the name. */}
        {fixedScope || (scopeOptions && onScopeChange) ? <span className="shrink-0 text-small text-fg-2">Ask about</span> : null}
        {fixedScope ? (
          <span className="inline-flex h-7 min-w-0 max-w-[60%] items-center truncate rounded-control bg-surface-2 px-2.5 text-small text-fg-2">
            <span className="truncate">{fixedScope}</span>
          </span>
        ) : scopeOptions && onScopeChange ? (
          <Select
            aria-label="Ask about"
            value={scope}
            onValueChange={onScopeChange}
            options={scopeOptions}
            className="h-7 w-auto max-w-[220px] border-transparent bg-surface-2 px-2.5 text-small"
          />
        ) : null}
        <span className="flex-1" />
        {value.trim() && draftAt && statusLabel(draft.status) ? (
          <span role="status" className="text-caption text-fg-3" data-testid="ask-draft-status">
            {statusLabel(draft.status)}
          </span>
        ) : null}
        {value.length > COUNT_FROM ? (
          <span
            className={cn('tabular text-caption', value.length >= MAX_QUESTION_CHARS ? 'text-danger-soft-fg' : 'text-fg-3')}
          >
            {value.length} / {MAX_QUESTION_CHARS}
          </span>
        ) : null}
        {sending ? (
          <Button size="sm" variant="secondary" className="md:h-[34px]" icon={<Stop weight="fill" />} onClick={onStop} aria-keyshortcuts="Escape" kbd="Esc">
            Stop
          </Button>
        ) : (
          <IconButton
            type="submit"
            label="Send question"
            variant="primary"
            icon={<ArrowUp weight="bold" />}
            disabled={!canSend}
            disabledReason={
              blocked
                ? 'AI features are paused right now.'
                : disabled
                  ? undefined
                  : trimmed.length === 0
                    ? 'Type a question first.'
                    : undefined
            }
            shortcut="Enter"
          />
        )}
      </div>
      <AiBlockedNote className="px-2 pb-1 pt-1.5" />
    </form>
  )
}
