'use client'

import * as React from 'react'
import { ChatCircleText, CheckCircle, MinusCircle, NotePencil, Trash, XCircle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, isApiError } from '@/lib/api/client'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { useFocusRequest } from '@/lib/hooks/use-focus'
import type { MarginNoteView } from '@/lib/reader/load-reader'
import { CANT_PARSE_TEXT, CHECK_DONT_KNOW_TEXT, isAttempt, MIN_TAKE_CHARS, VERDICT_LABELS, type CheckVerdict } from '@/lib/reader/take'

type Props = {
  topicId: string
  chunkId: string
  /** "passage 3": names the buttons for a screen reader, since every passage has the same two. */
  passageName: string
  notes: MarginNoteView[]
  onAdd: (note: MarginNoteView) => void
  onRemove: (id: string) => void
}

type Mode = 'idle' | 'note' | 'explain'

/** A reply the tutor wrote that the student can answer: an explanation, or the verdict that ended in another question. */
const isTutorItem = (note: MarginNoteView) => note.reply !== null && (note.kind === 'question' || note.kind === 'answer')
const isAnswer = (note: MarginNoteView) => note.kind === 'answer'

/** The icon says the verdict as well as the word does, so the verdict never rests on colour. */
const VERDICT_ICONS: Record<CheckVerdict, React.ElementType> = { right: CheckCircle, partly: MinusCircle, not_yet: XCircle }

/** The tutor's verdict on an answer: an icon and the word, with a spoken lead-in for a screen reader. */
function Verdict({ verdict }: { verdict: CheckVerdict }) {
  const Icon = VERDICT_ICONS[verdict]
  return (
    <p className="flex items-center gap-1.5 text-body-strong" data-verdict={verdict}>
      <Icon aria-hidden="true" weight="fill" className="size-4 shrink-0" />
      <span className="sr-only">Tutor&apos;s verdict: </span>
      <span>{VERDICT_LABELS[verdict]}</span>
    </p>
  )
}

/**
 * One passage's margin: the student's notes and explained questions, a box to write a note, and "Explain this
 * passage". The explanation is attempt-first: the tutor is asked only after the student has written what they
 * think the passage says (8 characters at least), or tapped "I can't parse any of it" (spec §5.2). The check
 * question that ends a reply has an answer box and "I don't know"; the tutor's verdict (Right, Partly, Not yet)
 * comes back in the same thread, with one more question when the answer was not right (spec §18.6).
 */
export function MarginPanel({ topicId, chunkId, passageName, notes, onAdd, onRemove }: Props) {
  const [mode, setMode] = React.useState<Mode>('idle')
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState<'note' | 'explain' | 'answer' | 'delete' | null>(null)
  const [answer, setAnswer] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const fieldRef = React.useRef<HTMLTextAreaElement>(null)
  const focus = useFocusRequest()
  const { blocked, report } = useAiStatus()

  React.useEffect(() => {
    if (mode !== 'idle') fieldRef.current?.focus()
  }, [mode])

  function open(next: Mode) {
    setMode(next)
    setText('')
    setError(null)
  }

  /** Closes the form and puts focus back on the button that opened it. */
  function cancel(opener: 'add' | 'explain') {
    open('idle')
    focus.request(opener)
  }

  async function saveNote() {
    const value = text.trim()
    if (!value || busy) return
    setBusy('note')
    setError(null)
    try {
      const { note } = await apiFetch<{ note: MarginNoteView }>(`/api/topics/${topicId}/margin-notes`, { method: 'POST', json: { chunkId, text: value } })
      onAdd(note)
      setMode('idle')
      setText('')
      // The form is gone: focus goes to the note it made.
      focus.request(`note:${note.id}`)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save the note. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function explain(cantParse: boolean) {
    if (busy || (!cantParse && !isAttempt(text))) return
    setBusy('explain')
    setError(null)
    try {
      const { note } = await apiFetch<{ note: MarginNoteView }>(`/api/topics/${topicId}/reader-explain`, {
        method: 'POST',
        json: cantParse ? { chunkId, cantParse: true } : { chunkId, take: text.trim() },
      })
      onAdd(note)
      setMode('idle')
      setText('')
      focus.request(`note:${note.id}`)
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      setError(isApiError(caught) ? caught.message : 'The tutor could not answer just now. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function sendAnswer(noteId: string, dontKnow: boolean) {
    if (busy || (!dontKnow && !answer.trim())) return
    setBusy('answer')
    setError(null)
    try {
      const { note } = await apiFetch<{ note: MarginNoteView }>(`/api/topics/${topicId}/reader-explain`, {
        method: 'POST',
        json: dontKnow ? { noteId, dontKnow: true } : { noteId, answer: answer.trim() },
      })
      onAdd(note)
      setAnswer('')
      // The answer box is gone: focus goes to the reply it got.
      focus.request(`note:${note.id}`)
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      setError(isApiError(caught) ? caught.message : 'The tutor could not answer just now. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function remove(note: MarginNoteView) {
    if (busy) return
    setBusy('delete')
    setError(null)
    try {
      await apiFetch(`/api/topics/${topicId}/margin-notes?id=${encodeURIComponent(note.id)}`, { method: 'DELETE' })
      onRemove(note.id)
      // The note (and the button that was pressed) is gone: focus goes to the button that adds one.
      focus.request('add')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not delete that. Try again.')
    } finally {
      setBusy(null)
    }
  }

  // Only the newest reply of the thread asks for an answer: an earlier question is behind it.
  const latestReply = [...notes].reverse().find(isTutorItem)
  const openQuestion = latestReply?.reply?.checkQuestion ? latestReply : null

  return (
    <div className="flex flex-col gap-3" data-margin="">
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2.5" aria-label={`Notes on ${passageName}`}>
          {notes.map((note) => (
            <li key={note.id} ref={focus.register(`note:${note.id}`)} tabIndex={-1} className="rounded-control bg-surface-2 px-3 py-2.5 text-small text-fg outline-none" data-note={isAnswer(note) ? 'answer' : note.kind}>
              {isAnswer(note) ? (
                <div className="flex flex-col gap-2">
                  <div>
                    <p className="text-caption text-fg-3">Your answer</p>
                    <p className="whitespace-pre-wrap break-words">{note.text}</p>
                  </div>
                  <div>
                    <p className="text-caption text-fg-3">Tutor</p>
                    {note.verdict ? <Verdict verdict={note.verdict} /> : null}
                    <p className="whitespace-pre-wrap break-words">{note.reply?.reply}</p>
                  </div>
                  {note.reply!.checkQuestion ? (
                    <div>
                      <p className="text-caption text-fg-3">Check yourself</p>
                      <p className="break-words text-body-strong">{note.reply!.checkQuestion}</p>
                    </div>
                  ) : null}
                </div>
              ) : note.kind === 'question' ? (
                <div className="flex flex-col gap-2">
                  <div>
                    <p className="text-caption text-fg-3">You wrote</p>
                    <p className="whitespace-pre-wrap break-words">{note.text}</p>
                  </div>
                  {note.reply ? (
                    <>
                      <div>
                        <p className="text-caption text-fg-3">Tutor</p>
                        <p className="whitespace-pre-wrap break-words">{note.reply.reply}</p>
                      </div>
                      {note.reply.checkQuestion ? (
                        <div>
                          <p className="text-caption text-fg-3">Check yourself</p>
                          <p className="break-words text-body-strong">{note.reply.checkQuestion}</p>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words">{note.text}</p>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 mt-1.5 text-fg-2"
                icon={<Trash />}
                disabled={busy === 'delete'}
                onClick={() => void remove(note)}
                aria-label={`Delete ${isAnswer(note) ? 'answer' : note.kind === 'question' ? 'explained question' : 'note'}: ${note.text.slice(0, 40)}`}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {openQuestion && mode === 'idle' ? (
        <form
          className="flex flex-col gap-2"
          aria-label={`Answer the check question on ${passageName}`}
          onSubmit={(event) => {
            event.preventDefault()
            void sendAnswer(openQuestion.id, false)
          }}
        >
          <label htmlFor={`answer-${openQuestion.id}`} className="text-small text-fg">
            {openQuestion.reply!.checkQuestion}
          </label>
          <Textarea id={`answer-${openQuestion.id}`} rows={2} maxRows={6} value={answer} onChange={(event) => setAnswer(event.target.value)} aria-label="Your answer" placeholder="Your answer" maxLength={2000} />
          <AiBlockedNote />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === 'answer'} disabled={!answer.trim() || !!blocked || (busy !== null && busy !== 'answer')}>
              Check my answer
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy !== null || !!blocked} onClick={() => void sendAnswer(openQuestion.id, true)}>
              {CHECK_DONT_KNOW_TEXT}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'idle' ? (
        // Help on request: on a wide screen with a pointer the two buttons show when the passage is hovered or has focus
        // (they stay in the tab order, and focus shows them); on touch and on a phone the passage's one "Margin notes"
        // control opens this panel. Reading comes first.
        <div className="flex flex-wrap gap-1.5 transition-opacity duration-120 lg:[@media(hover:hover)]:opacity-0 lg:[@media(hover:hover)]:group-focus-within/passage:opacity-100 lg:[@media(hover:hover)]:group-hover/passage:opacity-100">
          <Button ref={focus.register('add')} size="sm" variant="secondary" icon={<NotePencil />} onClick={() => open('note')} aria-label={`Add a note on ${passageName}`}>
            Add a note
          </Button>
          <Button ref={focus.register('explain')} size="sm" variant="secondary" icon={<ChatCircleText />} onClick={() => open('explain')} aria-label={`Explain this passage: ${passageName}`}>
            Explain this passage
          </Button>
        </div>
      ) : null}

      {mode === 'note' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void saveNote()
          }}
        >
          <Textarea ref={fieldRef} rows={3} maxRows={8} value={text} onChange={(event) => setText(event.target.value)} aria-label={`Your note on ${passageName}`} placeholder="Write in the margin" maxLength={4000} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === 'note'} disabled={!text.trim()} disabledReason="Write the note first.">
              Save note
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => cancel('add')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'explain' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void explain(false)
          }}
        >
          <label htmlFor={`take-${chunkId}`} className="text-small text-fg">
            What do you think this passage says, or what confuses you?
          </label>
          <Textarea id={`take-${chunkId}`} ref={fieldRef} rows={3} maxRows={8} value={text} onChange={(event) => setText(event.target.value)} aria-describedby={`take-help-${chunkId}`} maxLength={2000} />
          <p id={`take-help-${chunkId}`} className="text-caption text-fg-3">
            The tutor answers after you try. Write at least {MIN_TAKE_CHARS} characters, or tap the button below.
          </p>
          <AiBlockedNote />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === 'explain'} disabled={!isAttempt(text) || !!blocked} disabledReason={blocked ? undefined : `Write at least ${MIN_TAKE_CHARS} characters first.`}>
              Ask the tutor
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy === 'explain' || !!blocked} onClick={() => void explain(true)}>
              {CANT_PARSE_TEXT}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => cancel('explain')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    </div>
  )
}
