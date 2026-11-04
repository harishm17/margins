'use client'

import * as React from 'react'
import { ArrowUp, Stop } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Select, type SelectOption } from '@/components/ui/select'
import { MAX_QUESTION_CHARS } from '@/lib/ask/explain'
import { cn } from '@/lib/utils'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'

export { MAX_QUESTION_CHARS }
const COUNT_FROM = 1800
const MAX_ROWS = 8
const LINE = 24

export const ALL_MATERIALS = 'all'

type ComposerProps = {
  onSend: (question: string) => void
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
}

const parseAskDraft = (raw: unknown): { text: string } | null =>
  raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string' && (raw as { text: string }).text !== ''
    ? { text: (raw as { text: string }).text }
    : null

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
}: ComposerProps) {
  const draft = useServerDraft<{ text: string }>('ask', draftAt ? `${draftAt.courseId}:${draftAt.key}` : null, {
    projectId: draftAt?.courseId ?? null,
    parse: parseAskDraft,
  })
  // What was typed since the box showed; until then, a link's prefill, else the saved draft.
  // It belongs to one conversation: another conversation shows its own draft.
  const draftKey = draftAt ? `${draftAt.courseId}:${draftAt.key}` : null
  const [typedState, setTypedState] = React.useState<{ key: string | null; text: string | null }>({ key: draftKey, text: initialValue || null })
  const typed = typedState.key === draftKey ? typedState.text : null
  const setTyped = (text: string) => setTypedState({ key: draftKey, text })
  const value = typed ?? draft.value?.text ?? ''
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
    onSend(trimmed)
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
        placeholder="Ask about your materials..."
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
      <div className="mt-1 flex items-center gap-2">
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
