'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import { PRACTICE_DONE_SHARE, solvedCount } from './practice-keys'
import { usePracticeProgress } from './practice-progress'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { SHORT_LABELS, VIEW_IDS, VIEW_LABELS, type ContentKind, type ViewId } from './types'

type StudyTabsProps = {
  courseId: string
  topicId: string
  present: Record<ContentKind, boolean>
  progress: { notes: boolean; examples: boolean; quizScore: number | null }
  /** Every practice step key of the current content, to count solved steps in the browser. */
  practiceKeys: string[]
  previousId: string | null
  nextId: string | null
}

const Done = () => (
  <span role="img" aria-label="Completed" className="inline-flex">
    <CheckCircle weight="fill" className="size-4 text-accent" />
  </span>
)

const Missing = () => (
  <span
    role="img"
    aria-label="Not created yet"
    className="size-3.5 rounded-full border border-dashed border-fg-3"
  />
)

const Writing = () => (
  <span role="img" aria-label="Being written" className="inline-flex">
    <Spinner className="size-3.5 text-fg-3" />
  </span>
)

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Number keys 1 to 5 switch views, [ and ] go to the previous or next topic. They stay out of the
 * way of typing, dialogs, menus, and (for the numbers) a quiz being taken.
 */
function useTopicShortcuts(hrefs: { views: string[]; previous: string | null; next: string | null }) {
  const router = useRouter()
  const { keysSuspended } = useTopic()
  const latest = React.useRef({ hrefs, keysSuspended })
  React.useEffect(() => {
    latest.current = { hrefs, keysSuspended }
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      if (isTyping(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const { hrefs: current, keysSuspended: suspended } = latest.current

      if (/^[1-5]$/.test(event.key) && !suspended) {
        const href = current.views[Number(event.key) - 1]
        if (href) {
          event.preventDefault()
          router.push(href, { scroll: false })
        }
      } else if (event.key === '[' && current.previous) {
        event.preventDefault()
        router.push(current.previous)
      } else if (event.key === ']' && current.next) {
        event.preventDefault()
        router.push(current.next)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [router])
}

/**
 * The study path: Notes, Worked examples, Practice, Quiz, Voice practice, as links with ?view=.
 * Each carries a status glyph. Sticky under the top bar.
 */
export function StudyTabs({
  courseId,
  topicId,
  present,
  progress,
  practiceKeys,
  previousId,
  nextId,
}: StudyTabsProps) {
  const view = useTopicView()
  const { running, preparingNotes } = useTopic()
  const practice = usePracticeProgress(topicId)
  const base = `/courses/${courseId}/topics/${topicId}`
  const solved = solvedCount(practice.progress, practiceKeys)
  const practiceDone = practiceKeys.length > 0 && solved / practiceKeys.length >= PRACTICE_DONE_SHARE

  const hrefs = VIEW_IDS.map((id) => `${base}?view=${id}`)
  useTopicShortcuts({
    views: hrefs,
    previous: previousId ? `/courses/${courseId}/topics/${previousId}?view=${view}` : null,
    next: nextId ? `/courses/${courseId}/topics/${nextId}?view=${view}` : null,
  })

  function glyphFor(id: ViewId): React.ReactNode {
    if (id === 'voice') return null
    const kind = id as ContentKind
    // A just-opened topic's notes count as being written from the first paint.
    if ((running[kind] && !running[kind]?.done) || (kind === 'notes' && preparingNotes && !present.notes)) return <Writing />
    if (!present[kind]) return <Missing />
    switch (id) {
      case 'notes':
        return progress.notes ? <Done /> : null
      case 'examples':
        return progress.examples ? <Done /> : null
      case 'practice':
        if (practiceDone) return <Done />
        return solved > 0 ? <span className="tabular">{`${solved}/${practiceKeys.length}`}</span> : null
      default:
        return progress.quizScore !== null ? <span className="tabular">{Math.round(progress.quizScore)}%</span> : null
    }
  }

  // On a phone the labels are short enough for all five tabs to fit, so none is cut off.
  const items: TabItem[] = VIEW_IDS.map((id, index) => ({
    id,
    label: (
      <>
        <span className="sm:hidden">{SHORT_LABELS[id]}</span>
        <span className="max-sm:hidden">{VIEW_LABELS[id]}</span>
      </>
    ),
    href: hrefs[index],
    glyph: glyphFor(id),
  }))

  return (
    <Tabs
      aria-label="Study path"
      items={items}
      activeId={view}
      stickyPanel="[data-tab-panel]"
      className="sticky top-(--topbar-height) z-sticky -mx-4 bg-canvas px-4 max-sm:[&_a::after]:inset-x-1.5 max-sm:[&_[data-tab-indicator]]:inset-x-1.5 max-sm:[&_a]:gap-1 max-sm:[&_a]:px-1.5 max-sm:[&_a]:text-small md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
    />
  )
}
