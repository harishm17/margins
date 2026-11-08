'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { nextLineShows, nextPathStep, opensHere } from './activity-copy'
import { NextActivityCard, NextTag, PhonePath, QUIZ_LOW_SCORE, StepMarker, StepStatus, ToolLinks, type PhoneStep } from './path'
import { PRACTICE_DONE_SHARE, solvedCount } from './practice-keys'
import { usePracticeProgress } from './practice-progress'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { VIEW_LABELS, type ContentKind, type PathView } from './types'
import { formatScore } from '@/lib/format'

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
  /** Recall prompts answered, of all. Recall counts as done from the first, but is shown finished at the last. */
  recallProgress: { answered: number; total: number }
  /** The steps this topic offers, in order (a topic without concepts has no Recall). */
  steps: PathView[]
  /** What to do next on this topic: the path tags its step, and a card offers it. */
  nextActivity: { kind: ActivityKind; reason: string; href: string }
  /** The topic is not started and still being prepared: Warm-up and Recall say so, and no step is tagged Next until it settles. */
  preparingEntry?: boolean
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

const Preparing = () => (
  <span role="img" aria-label="Being prepared" className="inline-flex max-sm:sr-only">
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
      } else if (event.key === '[' && current.previous && !suspended) {
        event.preventDefault()
        router.push(current.previous)
      } else if (event.key === ']' && current.next && !suspended) {
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
  recallProgress,
  steps,
  nextActivity,
  preparingEntry = false,
}: StudyTabsProps) {
  const view = useTopicView()
  const { running, preparingNotes, keysSuspended: quizTaking } = useTopic()
  const practice = usePracticeProgress(topicId)
  const base = `/courses/${courseId}/topics/${topicId}`
  const solved = solvedCount(practice.progress, practiceKeys)
  const practiceDone = practiceKeys.length > 0 && solved / practiceKeys.length >= PRACTICE_DONE_SHARE

  const hrefs = steps.map((id) => `${base}?view=${id}`)
  useTopicShortcuts({
    views: hrefs,
    previous: previousId ? `/courses/${courseId}/topics/${previousId}?view=${view}` : null,
    next: nextId ? `/courses/${courseId}/topics/${nextId}?view=${view}` : null,
  })

  const done: Record<PathView, boolean> = {
    warmup: pathDone.warmup,
    read: pathDone.read || progress.notes,
    // The first graded answer counts the topic as recalled, but the step is finished when every prompt has one.
    recall: pathDone.recall && recallProgress.answered >= recallProgress.total,
    practice: practiceDone,
    quiz: progress.quizScore !== null,
  }
  // While the topic is being prepared the first step is not known yet, so none is tagged (the tag would move when the warm-up arrives).
  // Otherwise the tag is on the step the next activity belongs to while that is not done, else the first step that is not done.
  const nextStep = preparingEntry ? null : nextPathStep(nextActivity, steps, done)
  // One next signal: the tag in the path. The line below it only shows where the open view has no action of its own (see nextLineShows).
  const pathname = usePathname()
  const search = useSearchParams()
  const showLine = !preparingEntry && nextLineShows(nextActivity, view, steps, opensHere(nextActivity.href, pathname, search))

  /** A status after the label: content being written or missing, solved steps, the best quiz score. */
  function glyphFor(id: PathView): React.ReactNode {
    if (preparingEntry && (id === 'warmup' || id === 'recall')) return <Preparing />
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
        return progress.quizScore !== null ? <StepStatus>{formatScore(progress.quizScore)}</StepStatus> : null
      case 'recall':
        // Recalled by the first answer, finished by the last: say how far it is.
        return pathDone.recall && recallProgress.answered < recallProgress.total ? <StepStatus>{`${recallProgress.answered}/${recallProgress.total}`}</StepStatus> : null
      default:
        return null
    }
  }

  const lowScore = progress.quizScore !== null && progress.quizScore < QUIZ_LOW_SCORE ? progress.quizScore : null
  const items: TabItem[] = steps.map((id, index) => ({
    id,
    label: (
      <>
        <StepMarker number={index + 1} done={done[id]} next={nextStep === id} lowScore={id === 'quiz' ? lowScore : null} />
        {VIEW_LABELS[id]}
        {nextStep === id ? <NextTag /> : null}
      </>
    ),
    href: hrefs[index],
    glyph: glyphFor(id),
  }))

  /** The same statuses as words, for the phone's list of steps (the wide screen draws them as glyphs). */
  function statusFor(id: PathView): string | null {
    if (preparingEntry && (id === 'warmup' || id === 'recall')) return 'Being prepared'
    switch (id) {
      case 'read':
        if ((running.notes && !running.notes.done) || (preparingNotes && !present.notes)) return 'Being written'
        return present.notes ? null : 'Not created yet'
      case 'practice':
        if (running.practice && !running.practice.done) return 'Being written'
        if (!present.practice) return 'Not created yet'
        return solved > 0 && !practiceDone ? `${solved}/${practiceKeys.length}` : null
      case 'quiz':
        if (running.quiz && !running.quiz.done) return 'Being written'
        if (!present.quiz) return 'Not created yet'
        return progress.quizScore !== null ? formatScore(progress.quizScore) : null
      case 'recall':
        return pathDone.recall && recallProgress.answered < recallProgress.total ? `${recallProgress.answered}/${recallProgress.total}` : null
      default:
        return null
    }
  }
  const phoneSteps: PhoneStep[] = steps.map((id, index) => ({
    id,
    href: hrefs[index],
    done: done[id],
    next: nextStep === id,
    status: statusFor(id),
    lowScore: id === 'quiz' ? lowScore : null,
  }))

  return (
    <>
      {/* A phone gets one line, "Step 2 of 5: Read", that opens the steps (W2-02); the five-tab strip is for wider screens. */}
      <PhonePath
        steps={phoneSteps}
        view={view}
        className="sticky top-(--topbar-height) z-sticky -mx-4 bg-canvas px-4 group-data-[attempt]/topic:hidden sm:hidden"
      />
      <Tabs
        aria-label="Topic path"
        items={items}
        activeId={view}
        stickyPanel="[data-tab-panel]"
        trailing={quizTaking ? undefined : <ToolLinks courseId={courseId} topicId={topicId} />}
        className="sticky top-(--topbar-height) z-sticky -mx-4 bg-canvas px-4 max-sm:hidden md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
      />
      {/* On the voice view the student is choosing what to do out loud; the way on can wait. */}
      {view === 'voice' || !showLine ? null : <NextActivityCard next={nextActivity} />}
    </>
  )
}
