'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, CaretDown, ListBullets } from '@phosphor-icons/react/dist/ssr'
import { SourceIcon } from '@/components/learning/source-link'
import { Button } from '@/components/ui/button'
import { CheckGradeContext, ExplainerDraftContext } from '@/components/ui/check-context'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { viewerUrl } from '@/lib/chat/citations'
import { formatDate } from '@/lib/format'
import { extractOutline } from '@/lib/markdown-outline'
import { cn } from '@/lib/utils'
import { CompletionRow } from './completion-row'
import { cleanNotes, readMinutes } from './notes-text'
import { apiFetch } from '@/lib/api/client'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { GapExplainerState } from '@/lib/learning/explainer-server'
import { GapExplainer } from './gap-explainer'
import { RecallAbandonOnOpen } from './recall-abandon'
import { scrollToElement, useSeenInView } from './use-seen-in-view'
import { useOptionalTopic } from './topic-provider'
import { useCheckGrader } from './use-check-grader'
import { useMarkComplete } from './use-mark-complete'
import type { NotesContent, TopicCitation } from './types'

function citationLabel(citation: TopicCitation): string {
  return citation.pages ? `${citation.filename}, p. ${citation.pages}` : citation.filename
}

function SourcesList({ citations, className, id }: { citations: TopicCitation[]; className?: string; id: string }) {
  if (citations.length === 0) return null
  return (
    <section aria-labelledby={id} className={className}>
      <h2 id={id} className="mb-2 text-body-strong text-fg">
        Sources
      </h2>
      <ul className="flex flex-col gap-1.5">
        {citations.map((citation) => {
          const content = (
            <>
              <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 text-fg-3 [&>svg]:size-4">
                <SourceIcon filename={citation.filename} />
              </span>
              <span className="min-w-0 break-words">{citationLabel(citation)}</span>
            </>
          )
          return (
            <li key={`${citation.materialId ?? citation.filename}|${citation.pages ?? ''}`}>
              {citation.materialId ? (
                <a
                  href={viewerUrl({
                    materialId: citation.materialId,
                    filename: citation.filename,
                    pageStart: citation.page,
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 rounded-chip text-small text-fg-2 transition-colors duration-120 hover:text-fg"
                >
                  {content}
                </a>
              ) : (
                <span className="flex items-start gap-2 text-small text-fg-2">{content}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The id of the last heading that has scrolled past the sticky bars. */
function useScrollSpy(ids: string[], root: React.RefObject<HTMLElement | null>): string | null {
  const [active, setActive] = React.useState<string | null>(null)
  const key = ids.join('|')

  React.useEffect(() => {
    const list = key ? key.split('|') : []
    if (list.length === 0) return
    let frame = 0
    const update = () => {
      frame = 0
      let current = list[0]
      for (const id of list) {
        const element = document.getElementById(id)
        if (!element) continue
        if (element.getBoundingClientRect().top <= 140) current = id
        else break
      }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      if (atBottom && window.scrollY > 0) current = list[list.length - 1]
      setActive(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // The markdown loads as its own chunk, so the headings can appear after this runs.
    const observer = new MutationObserver(schedule)
    if (root.current) observer.observe(root.current, { childList: true, subtree: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [key, root])

  return active
}

function jumpTo(id: string) {
  const element = document.getElementById(id)
  if (!element) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  history.replaceState(null, '', `#${id}`)
}

type NotesViewProps = {
  topicId: string
  notes: NotesContent
  completed: boolean
  nextHref: string
  /** The link after "marked as read": "Next: Recall", "Next: Worked examples". */
  nextLabel: string
  /**
   * "reading": the notes are the reading of a topic with no pages to read, and end with "Mark as read".
   * "explainer": the full explainer (spec §5.4); reading it is not reading the student's pages, so it can't mark the
   * topic read and ends with a link on.
   */
  form?: 'reading' | 'explainer'
}

/** The name of the idea the student came to the full explainer for (spec 18.5): the notes open at the section that names it. */
const ExplainerFocusContext = React.createContext<string | null>(null)

/**
 * Notes as a textbook page: a reading column and, from 1200px, a sticky right rail with the
 * outline (scrollspy) and the sources. Narrower than that the outline becomes a "Contents"
 * menu above the notes and the sources move to the end. The "Check yourself" blocks in the notes are
 * attempt-first and record the student's own grade.
 */
export function NotesView({ topicId, notes, completed, nextHref, nextLabel, form = 'reading' }: NotesViewProps) {
  const gradeCheck = useCheckGrader(topicId)
  const projectId = useOptionalTopic()?.courseId ?? null
  const focusConceptName = React.useContext(ExplainerFocusContext)
  const body = React.useMemo(() => cleanNotes(notes.text), [notes.text])
  const outline = React.useMemo(() => extractOutline(body, 2).filter((item) => item.level === 2), [body])
  const minutes = readMinutes(body)
  const articleRef = React.useRef<HTMLElement>(null)
  const active = useScrollSpy(
    outline.map((item) => item.id),
    articleRef
  )
  const { completed: isCompleted, saving, mark } = useMarkComplete(topicId, 'notesCompleted', completed)
  const hasOutline = outline.length >= 2
  // The full explainer: a section on screen is instruction on the idea its heading names (spec 18.5), once per day.
  useSeenInView(
    () => outline.flatMap((item) => { const element = document.getElementById(item.id); return element ? [{ key: item.id, element, payload: item.text }] : [] }),
    (heading) => void apiFetch(`/api/topics/${topicId}/explainer`, { method: 'POST', json: { action: 'section_viewed', kind: 'full_explainer', heading } }).catch(() => undefined),
    { watch: articleRef, enabled: form === 'explainer', deps: [body] }
  )
  // Coming for one idea: open at the first section that names it.
  const scrolled = React.useRef(false)
  React.useEffect(() => {
    if (form !== 'explainer' || !focusConceptName || scrolled.current) return
    const wanted = focusConceptName.toLowerCase()
    const apply = () => {
      const section = outline.find((item) => item.text.toLowerCase().includes(wanted))
      const element = section ? document.getElementById(section.id) : null
      if (!element) return false
      scrolled.current = true
      scrollToElement(element)
      return true
    }
    if (apply()) return
    // The markdown loads as its own chunk: wait for its headings.
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect()
    })
    if (articleRef.current) observer.observe(articleRef.current, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [form, focusConceptName, outline])

  return (
    <div className="flex items-start gap-12">
      <article ref={articleRef} className="min-w-0 max-w-[720px] flex-1">
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-fg-3">
          {minutes > 0 ? <span>{minutes} min read</span> : null}
          <time dateTime={notes.updatedAt} suppressHydrationWarning>
            Updated {formatDate(notes.updatedAt)}
          </time>
          {hasOutline ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary" className="ml-auto min-[1200px]:hidden" icon={<ListBullets />}>
                  <span className="inline-flex items-center gap-1">
                    Contents
                    <CaretDown className="size-3.5" />
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-[calc(100vw-32px)]">
                {outline.map((item) => (
                  <DropdownMenuItem key={item.id} onSelect={() => jumpTo(item.id)}>
                    {item.text}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <CheckGradeContext.Provider value={gradeCheck}>
          <ExplainerDraftContext.Provider value={{ projectId, topicId, scope: 'notes' }}>
          <LazyMarkdown variant="reading">{body}</LazyMarkdown>
          </ExplainerDraftContext.Provider>
        </CheckGradeContext.Provider>

        <SourcesList
          id="notes-sources-inline"
          citations={notes.citations}
          className="mt-12 border-t border-border pt-6 min-[1200px]:hidden"
        />

        {form === 'explainer' ? (
          <div className="mt-12 border-t border-border pt-6">
            <Button asChild variant="secondary">
              <Link href={nextHref} scroll={false}>
                {nextLabel}
                <ArrowRight aria-hidden="true" className="ml-1 size-4" />
              </Link>
            </Button>
          </div>
        ) : (
          <CompletionRow
            completed={isCompleted}
            saving={saving}
            markLabel="Mark as read"
            doneText="You've read these notes."
            nextHref={nextHref}
            nextLabel={nextLabel}
            onMark={mark}
          />
        )}
      </article>

      <aside
        aria-label="Notes outline and sources"
        className="sticky top-[120px] hidden w-[220px] shrink-0 flex-col gap-8 min-[1200px]:flex"
      >
        {hasOutline ? (
          <nav aria-labelledby="notes-outline">
            <h2 id="notes-outline" className="mb-2 text-body-strong text-fg">
              On this page
            </h2>
            <ul className="flex flex-col">
              {outline.map((item) => {
                const current = item.id === active
                return (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      aria-current={current ? 'location' : undefined}
                      onClick={(event) => {
                        event.preventDefault()
                        jumpTo(item.id)
                      }}
                      className={cn(
                        'block border-l-2 py-1 pl-3 text-small transition-colors duration-120',
                        current
                          ? 'border-accent font-medium text-accent'
                          : 'border-border text-fg-2 hover:border-border-strong hover:text-fg'
                      )}
                    >
                      {item.text}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        ) : null}
        <SourcesList id="notes-sources" citations={notes.citations} />
      </aside>
    </div>
  )
}

/** Records that the explainer was opened (the visit the next-activity selector reads) and abandons any open recall card. */
function ExplainerVisit({ topicId }: { topicId: string }) {
  React.useEffect(() => {
    void apiFetch(`/api/topics/${topicId}/explainer`, { method: 'POST', json: { action: 'viewed' } }).catch(() => undefined)
  }, [topicId])
  return null
}

type ExplainerViewProps = {
  topicId: string
  /** What the recall left out, explained. `none` when there was no recall gap: only the full form is offered. */
  gaps: GapExplainerState
  /** The full explainer (the notes' screen, or its generating state), built by the page. */
  full: React.ReactNode
  nextHref: string
  nextLabel: string
  /** `?focus=<conceptId>`: the concept the next activity or a pointer opened the explainer for (spec 18.5): the page opens at its section. */
  focusConceptId?: string | null
}

type Form = 'gaps' | 'full'

/**
 * The explainer (spec §5.4), once it is open: the gap form for what the student's recall missed, and the full
 * form, the lesson notes. A student with gaps starts on the gaps. Opening it counts as a visit and abandons an open
 * recall card, since the book is no longer closed.
 */
export function ExplainerView({ topicId, gaps, full, nextHref, nextLabel, focusConceptId = null }: ExplainerViewProps) {
  const hasGaps = gaps.status !== 'none'
  const [form, setForm] = React.useState<Form>(hasGaps ? 'gaps' : 'full')
  const showingGaps = form === 'gaps' && hasGaps
  // The full explainer opens at the section that names the idea; the page passes only its id, so the name is fetched.
  const [focusName, setFocusName] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!focusConceptId || showingGaps) return
    let cancelled = false
    void apiFetch<{ conceptName: string | null }>(`/api/topics/${topicId}/explainer?concept=${encodeURIComponent(focusConceptId)}`)
      .then((found) => {
        if (!cancelled) setFocusName(found.conceptName)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [topicId, focusConceptId, showingGaps])
  return (
    <ExplainerFocusContext.Provider value={focusName}>
      <RecallAbandonOnOpen topicId={topicId} />
      <ExplainerVisit topicId={topicId} />
      {hasGaps ? (
        <SegmentedControl<Form>
          aria-label="Explainer form"
          className="mb-6"
          value={form}
          onValueChange={setForm}
          options={[
            { value: 'gaps', label: 'What you missed' },
            { value: 'full', label: 'Full explainer' },
          ]}
        />
      ) : null}
      {showingGaps ? <GapExplainer topicId={topicId} state={gaps} nextHref={nextHref} nextLabel={nextLabel} focusConceptId={focusConceptId} /> : full}
    </ExplainerFocusContext.Provider>
  )
}
