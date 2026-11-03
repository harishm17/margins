import * as React from 'react'
import { Check } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import type { CheckGrade } from '@/lib/reader/checks'

/** The three answers to "How did you do?" after looking at the source: the student's own grade (level 2, for display). */
export const SELF_GRADES: { id: CheckGrade; label: string }[] = [
  { id: 'got_it', label: 'Got it' },
  { id: 'partly', label: 'Partly' },
  { id: 'missed', label: 'Missed' },
]

export const gradeLabel = (grade: CheckGrade): string => SELF_GRADES.find((item) => item.id === grade)?.label ?? ''

/** "How did you do?" with Got it, Partly and Missed, shared by the reading's checks and Ask's check card. */
export function SelfGradeRow({ disabled, onGrade }: { disabled: boolean; onGrade: (grade: CheckGrade) => void }) {
  return (
    <div role="group" aria-label="How did you do?" className="mt-2.5 flex flex-wrap items-center gap-2">
      <span className="text-small text-fg-2">How did you do?</span>
      {SELF_GRADES.map((item) => (
        <Button key={item.id} size="sm" variant="secondary" disabled={disabled} onClick={() => onGrade(item.id)}>
          {item.label}
        </Button>
      ))}
    </div>
  )
}

/** The line that says the grade was saved. Focus lands on it when it appears, so it can be read out. */
export function GradeSaved({ ref, children }: { ref?: React.Ref<HTMLParagraphElement>; children: React.ReactNode }) {
  return (
    <p ref={ref} tabIndex={-1} className="mt-2 flex items-start gap-1.5 text-small text-fg-2 outline-none" role="status">
      <Check aria-hidden="true" weight="bold" className="mt-0.5 size-4 shrink-0 text-accent" />
      {children}
    </p>
  )
}
