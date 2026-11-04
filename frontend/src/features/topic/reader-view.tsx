'use client'

import * as React from 'react'
import { ArrowSquareOut, Crosshair, NotePencil } from '@phosphor-icons/react/dist/ssr'
import { SourceIcon } from '@/components/learning/source-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { apiFetch } from '@/lib/api/client'
import { viewerUrl } from '@/lib/chat/citations'
import { demoteHeadings } from '@/lib/reader/passage-text'
import type { MarginNoteView, ReaderCheckView, ReaderData, ReaderFile, ReaderPassage } from '@/lib/reader/load-reader'
import { CompletionRow } from './completion-row'
import { MarginPanel } from './reader-margin'
import { ReaderCheck } from './reader-check'
import { useMarkComplete } from './use-mark-complete'

type Props = {
  topicId: string
  reader: ReaderData
  /** The topic was read before ("I've read it" was pressed, or the notes were marked read). */
  completed: boolean
  nextHref: string
  nextLabel: string
  /** `?focus=<conceptId>`: the concept a pointer or the next activity opened the reader for (spec 18.3): its claim passages are marked and the reader opens at the first. */
  focusConceptId?: string | null
}

const PDF_NOTE_KEY = 'margins.readerPdfNoteClosed'
const pdfNoteListeners = new Set<() => void>()
const subscribePdfNote = (listener: () => void) => {
  pdfNoteListeners.add(listener)
  return () => void pdfNoteListeners.delete(listener)
}
const pdfNoteClosed = () => {
  try {
    return window.localStorage.getItem(PDF_NOTE_KEY) !== null
  } catch {
    return false
  }
}

/** The caveat about text taken from a PDF: said once, then gone. Each page keeps its own link to the original. */
function PdfNote() {
  // Closed on the server so the first paint never flashes it for a student who has dismissed it.
  const closed = React.useSyncExternalStore(subscribePdfNote, pdfNoteClosed, () => true)
  if (closed) return null
  return (
    <div className="mb-8 flex max-w-[680px] flex-wrap items-center gap-x-3 gap-y-1 text-small text-fg-2" data-testid="reader-pdf-note">
      <p className="min-w-0 flex-1 basis-64">Text taken from a PDF can lose its layout and maths. The original is the better view for figures and equations: each page links to it.</p>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        onClick={() => {
          try {
            window.localStorage.setItem(PDF_NOTE_KEY, '1')
          } catch {
            // Private mode: it comes back next time, which is harmless.
          }
          pdfNoteListeners.forEach((listener) => listener())
        }}
      >
        Got it
      </Button>
    </div>
  )
}

function jumpTo(id: string) {
  const element = document.getElementById(id)
  if (!element) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  history.replaceState(null, '', `#${id}`)
}

const passageDomId = (chunkId: string) => `passage-${chunkId}`

/** The passage a pointer's address names: `#chunk-<id>` (a pointer link, the next activity). */
const hashedChunk = () => (typeof window !== 'undefined' && window.location.hash.startsWith('#chunk-') ? window.location.hash.slice('#chunk-'.length) : null)

/**
 * The reader opened for an idea (spec 18.3, 18.5): asks which passages hold its claims, marks them "Focus here" (the
 * warm-up's marks) and opens at the one the address names, else the first. The markdown loads in pieces and moves the
 * page, so the reader is kept at the passage for a couple of seconds, until the student scrolls themselves.
 */
function useConceptFocus(topicId: string, conceptId: string | null | undefined, shown: ReadonlySet<string>): ReadonlySet<string> {
  const [found, setFound] = React.useState<{ conceptId: string; chunkIds: string[] } | null>(null)
  React.useEffect(() => {
    if (!conceptId) return
    let cancelled = false
    apiFetch<{ chunkIds: string[] }>(`/api/topics/${topicId}/reader-checks?conceptId=${encodeURIComponent(conceptId)}`)
      .then((body) => {
        if (!cancelled) setFound({ conceptId, chunkIds: body.chunkIds })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [topicId, conceptId])

  const ids = React.useMemo(() => (found && found.conceptId === conceptId ? found.chunkIds.filter((id) => shown.has(id)) : []), [found, conceptId, shown])
  const marked = React.useMemo(() => new Set(ids), [ids])
  const target = React.useMemo(() => {
    const named = hashedChunk()
    return named && shown.has(named) ? named : (ids[0] ?? null)
  }, [ids, shown])

  React.useEffect(() => {
    if (!target) return
    const element = document.getElementById(passageDomId(target))
    if (!element) return
    let moved = false
    const stop = () => {
      moved = true
    }
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const name of events) window.addEventListener(name, stop, { passive: true })
    const align = () => {
      if (moved) return
      element.scrollIntoView({ behavior: 'auto', block: 'start' })
    }
    align()
    const observer = new MutationObserver(align)
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setTimeout(() => observer.disconnect(), 2500)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      for (const name of events) window.removeEventListener(name, stop)
    }
  }, [target])

  return marked
}

function originalHref(file: ReaderFile, page: number | null): string {
  return viewerUrl({ materialId: file.materialId, filename: file.filename, pageStart: page })
}

function PageDivider({ file, page }: { file: ReaderFile; page: number }) {
  return (
    <div className="mb-3 mt-10 flex items-center gap-3 text-caption text-fg-3 first:mt-0">
      <span className="tabular shrink-0 font-medium text-fg-2">p. {page}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {file.pdf ? (
        <a
          href={originalHref(file, page)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-chip text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg max-sm:min-h-11"
        >
          Open the original at p. {page}
          <ArrowSquareOut aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </div>
  )
}

type PassageProps = {
  topicId: string
  file: ReaderFile
  passage: ReaderPassage
  /** The reader was opened for an idea whose claim is in this passage: it is marked like a warm-up focus. */
  focused: boolean
  number: number
  notes: MarginNoteView[]
  check: ReaderCheckView | null
  onAdd: (note: MarginNoteView) => void
  onRemove: (id: string) => void
}

/** One passage: its text (with Focus here when the warm-up says so), its margin, and the check that follows it. */
function Passage({ topicId, file, passage, focused, number, notes, check, onAdd, onRemove }: PassageProps) {
  const [open, setOpen] = React.useState(false)
  const marginId = `margin-${passage.chunkId}`
  const name = `passage ${number}`
  const body = React.useMemo(() => demoteHeadings(passage.text), [passage.text])
  const marked = passage.focus || focused
  return (
    <>
      {passage.divider !== null ? <PageDivider file={file} page={passage.divider} /> : null}
      <div id={passageDomId(passage.chunkId)} className="group/passage scroll-mt-[140px] lg:grid lg:grid-cols-[minmax(0,680px)_minmax(240px,1fr)] lg:gap-x-10" data-passage="">
        <div className={marked ? 'border-l-2 border-accent pl-4' : undefined} data-focus={marked ? '' : undefined}>
          {marked ? (
            <Badge tone="accent" icon={<Crosshair aria-hidden="true" />} className="mb-2">
              Focus here
            </Badge>
          ) : null}
          <LazyMarkdown variant="reading">{body}</LazyMarkdown>
        </div>
        <div className="mt-3 lg:mt-1">
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 text-fg-2 lg:hidden"
            icon={<NotePencil />}
            aria-expanded={open}
            aria-controls={marginId}
            onClick={() => setOpen((current) => !current)}
          >
            {notes.length > 0 ? `Margin notes (${notes.length})` : 'Margin notes'}
          </Button>
          <div id={marginId} className={open ? 'mt-2 lg:mt-0' : 'hidden lg:block'}>
            <MarginPanel topicId={topicId} chunkId={passage.chunkId} passageName={name} notes={notes} onAdd={onAdd} onRemove={onRemove} />
          </div>
        </div>
      </div>
      {check ? <ReaderCheck topicId={topicId} check={check} filename={file.filename} materialId={file.materialId} pdf={file.pdf} /> : <div className="h-6" aria-hidden="true" />}
    </>
  )
}

/**
 * The source reader (spec §5.2, D10): the student's own pages as text, in order, with a margin for notes and
 * "Explain this passage" beside each passage, "Before you go on" checks after the sections that hold a claim,
 * and "Focus here" on the passages the warm-up says to look at. Nothing is hidden: the student reads it all.
 * Text taken from a PDF can lose layout and maths, so each page links to the original.
 */
export function ReaderView({ topicId, reader, completed, nextHref, nextLabel, focusConceptId = null }: Props) {
  const [notes, setNotes] = React.useState<MarginNoteView[]>(reader.notes)
  const { completed: isCompleted, saving, mark } = useMarkComplete(topicId, 'readAt', completed)
  const checks = React.useMemo(() => new Map(reader.checks.map((check) => [check.afterChunkId, check])), [reader.checks])
  const byChunk = React.useMemo(() => {
    const map = new Map<string, MarginNoteView[]>()
    for (const note of notes) map.set(note.chunkId, [...(map.get(note.chunkId) ?? []), note])
    return map
  }, [notes])
  const hasPdf = reader.files.some((file) => file.pdf)
  // Passages are numbered through all the files, for the names a screen reader hears on their buttons.
  const numbers = React.useMemo(() => new Map(reader.files.flatMap((file) => file.passages).map((passage, index) => [passage.chunkId, index + 1])), [reader.files])
  const questions = reader.focusQuestions
  const shown = React.useMemo(() => new Set(reader.files.flatMap((file) => file.passages.map((passage) => passage.chunkId))), [reader.files])
  const conceptFocus = useConceptFocus(topicId, focusConceptId, shown)

  return (
    <div className="max-w-[1000px]">
      {reader.focusCount > 0 ? (
        <InlineAlert className="mb-6 max-w-[680px]" tone="neutral" icon={<Crosshair aria-hidden="true" />}>
          {reader.focusCount === 1 ? 'One passage is' : `${reader.focusCount} passages are`} marked Focus here, for the ideas your warm-up showed you to look at. You still read everything.
        </InlineAlert>
      ) : null}

      {questions.length > 0 ? (
        <section aria-labelledby="read-to-answer" className="mb-8 max-w-[680px] rounded-card border border-border bg-surface-2 px-4 py-4 sm:px-5">
          <h2 id="read-to-answer" className="text-body-strong text-fg">
            Read to answer
          </h2>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-small text-fg max-sm:gap-0">
            {questions.map((item) => (
              <li key={`${item.objectiveIndex}:${item.question}`}>
                {item.chunkId ? (
                  <a
                    href={`#${passageDomId(item.chunkId)}`}
                    onClick={(event) => {
                      event.preventDefault()
                      jumpTo(passageDomId(item.chunkId as string))
                    }}
                    className="rounded-chip underline decoration-border-strong decoration-1 underline-offset-[3px] hover:decoration-fg-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                  >
                    {item.question}
                    <span className="sr-only"> (go to the passage)</span>
                  </a>
                ) : (
                  item.question
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {hasPdf ? <PdfNote /> : null}

      {reader.files.map((file) => (
        <section key={file.materialId} aria-labelledby={`file-${file.materialId}`} className="mb-10">
          <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-3">
            <h2 id={`file-${file.materialId}`} className="flex min-w-0 items-center gap-2 text-subheading text-fg">
              <span aria-hidden="true" className="inline-flex shrink-0 text-fg-3 [&>svg]:size-4">
                <SourceIcon filename={file.filename} />
              </span>
              <span className="min-w-0 break-words">{file.filename}</span>
            </h2>
            <a
              href={originalHref(file, null)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-chip text-small text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg max-sm:min-h-11"
            >
              Open the original
              <ArrowSquareOut aria-hidden="true" className="size-3.5" />
              <span className="sr-only"> ({file.filename})</span>
            </a>
          </div>
          {file.passages.map((passage) => (
            <Passage
              key={passage.chunkId}
              topicId={topicId}
              file={file}
              passage={passage}
              focused={conceptFocus.has(passage.chunkId)}
              number={numbers.get(passage.chunkId) ?? 0}
              notes={byChunk.get(passage.chunkId) ?? []}
              check={checks.get(passage.chunkId) ?? null}
              onAdd={(note) => setNotes((current) => [...current, note])}
              onRemove={(id) => setNotes((current) => current.filter((note) => note.id !== id))}
            />
          ))}
        </section>
      ))}

      <div className="max-w-[680px]">
        <CompletionRow
          completed={isCompleted}
          saving={saving}
          markLabel="I've read it"
          doneText="You've read this topic."
          nextHref={nextHref}
          nextLabel={nextLabel}
          onMark={mark}
        />
      </div>
    </div>
  )
}
