'use client'

import * as React from 'react'
import Link from 'next/link'
import { Timer } from '@phosphor-icons/react/dist/ssr'

/**
 * A slim line at the top of every course page while a mock exam is being taken: it says so and links back, so a
 * student who stepped out (to the plan, to a topic) is not left wondering where the exam went. The exam itself,
 * which has its own layout, does not show it. Pages that fill the screen (Ask) subtract --exam-cue-height, so the
 * line never pushes their bottom edge out of view.
 */
export function ExamInProgressCue({ courseId, examId }: { courseId: string; examId: string }) {
  const ref = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    const root = document.documentElement
    const element = ref.current
    if (!element) return
    const update = () => root.style.setProperty('--exam-cue-height', `${element.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--exam-cue-height')
    }
  }, [])
  return (
    <aside
      ref={ref}
      aria-label="Mock exam in progress"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-warning-soft px-4 py-1.5 text-small text-warning-soft-fg md:px-6 lg:px-8"
    >
      <span className="inline-flex items-center gap-1.5">
        <Timer aria-hidden="true" className="size-4" />
        Mock exam in progress
      </span>
      <Link
        href={`/courses/${courseId}/exams/${examId}/take`}
        className="rounded-chip font-medium underline decoration-1 underline-offset-[3px] hover:no-underline"
      >
        Back to your mock exam
      </Link>
    </aside>
  )
}
