'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { pathStepFor } from './activity-copy'
import { NextActivityCard, NextTag, StepMarker, StepStatus, ToolLinks } from './path'
import { PRACTICE_DONE_SHARE, solvedCount } from './practice-keys'
import { usePracticeProgress } from './practice-progress'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { SHORT_LABELS, VIEW_LABELS, type ContentKind, type PathView } from './types'

type StudyTabsProps = {
  courseId: string
  topicId: string
  present: Record<ContentKind, boolean>
  progress: { notes: boolean; examples: boolean; quizScore: number | null }
  /** Every practice step key of the current content, to count solved steps in the browser. */
  practiceKeys: string[]
  previousId: string | null
  nextId: string | null
  /** Which steps of the path are done. */
  pathDone: { warmup: boolean; read: boolean; recall: boolean }
  /** The steps this topic offers, in order (a topic without concepts has no Recall). */
  steps: PathView[]
  /** What to do next on this topic: the path tags its step, and a card offers it. */
  nextActivity: { kind: ActivityKind; reason: string; href: string }
}

const Missing = () => (
  <span
    role="img"
    aria-label="Not created yet"
    className="size-3.5 rounded-full border border-dashed border-fg-3 max-sm:sr-only"
  />
)

const Writing = () => (
  <span role="img" aria-label="Being written" className="inline-flex max-sm:sr-only">
    <Spinner className="size-3.5 text-fg-3" />
  </span>
)

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Number keys 1 to 5 switch steps of the path, [ and ] go to the previous or next topic. They stay out of
 * the way of typing, dialogs, menus, and (for the numbers) a quiz being taken.
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
 * The topic path (spec §5): Warm-up, Read, Recall, Practice, Quiz as links with ?view=, each with a marker
 * (a number, or a check once done) and the step the next activity belongs to tagged "Next". The tools sit
 * beside it on a wide screen and in one menu under it on a phone. Sticky under the top bar.
 */
export function StudyTabs({
  courseId,
  topicId,
  present,
  progress,
  practiceKeys,
  previousId,
  nextId,
  pathDone,
  steps,
  nextActivity,
}: StudyTabsProps) {
  const view = useTopicView()
  const { running, preparingNotes } = useTopic()
  const practice = usePracticeProgress(topicId)
  const base = `/courses/${courseId}/topics/${topicId}`
  const solved = solvedCount(practice.progress, practiceKeys)
  const practiceDone = practiceKeys.length > 0 && solved / practiceKeys.length >= PRACTICE_DONE_SHARE
  const nextStep = pathStepFor(nextActivity.kind)

  const hrefs = steps.map((id) => `${base}?view=${id}`)
  useTopicShortcuts({
    views: hrefs,
    previous: previousId ? `/courses/${courseId}/topics/${previousId}?view=${view}` : null,
    next: nextId ? `/courses/${courseId}/topics/${nextId}?view=${view}` : null,
  })

  const done: Record<PathView, boolean> = {
    warmup: pathDone.warmup,
    read: pathDone.read || progress.notes,
    recall: pathDone.recall,
    practice: practiceDone,
    quiz: progress.quizScore !== null,
  }

  /** A status after the label: content being written or missing, solved steps, the best quiz score. */
  function glyphFor(id: PathView): React.ReactNode {
    switch (id) {
      case 'read':
        // A just-opened topic's notes count as being written from the first paint.
        if ((running.notes && !running.notes.done) || (preparingNotes && !present.notes)) return <Writing />
        return present.notes ? null : <Missing />
      case 'practice':
        if (running.practice && !running.practice.done) return <Writing />
        if (!present.practice) return <Missing />
        return solved > 0 && !practiceDone ? <StepStatus>{`${solved}/${practiceKeys.length}`}</StepStatus> : null
      case 'quiz':
        if (running.quiz && !running.quiz.done) return <Writing />
        if (!present.quiz) return <Missing />
        return progress.quizScore !== null ? <StepStatus>{`${Math.round(progress.quizScore)}%`}</StepStatus> : null
      default:
        return null
    }
  }

  // On a phone the labels are short and the markers small, so all five steps fit without scrolling.
  const items: TabItem[] = steps.map((id, index) => ({
    id,
    label: (
      <>
        <StepMarker number={index + 1} done={done[id]} next={nextStep === id} />
        <span className="sm:hidden">{SHORT_LABELS[id]}</span>
        <span className="max-sm:hidden">{VIEW_LABELS[id]}</span>
        {nextStep === id ? <NextTag /> : null}
      </>
    ),
    href: hrefs[index],
    glyph: glyphFor(id),
    // On a phone a glyph is read out, not drawn (no room), so its gap goes too.
    glyphClassName: 'max-sm:-ml-1',
  }))

  return (
    <>
      <Tabs
        aria-label="Topic path"
        items={items}
        activeId={view}
        stickyPanel="[data-tab-panel]"
        trailing={<ToolLinks courseId={courseId} topicId={topicId} />}
        className="sticky top-(--topbar-height) z-sticky -mx-4 bg-canvas px-4 max-sm:[&_a::after]:inset-x-1 max-sm:[&_[data-tab-indicator]]:inset-x-1 max-sm:[&_a]:gap-1 max-sm:[&_a]:px-1 max-sm:[&_a]:text-small md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
      />
      {/* On the voice view the student is choosing what to do out loud; the way on can wait. */}
      {view === 'voice' ? null : <NextActivityCard next={nextActivity} />}
    </>
  )
}
