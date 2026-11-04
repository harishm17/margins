import { Progress } from '@/components/ui/progress'
import { COURSE_STAGES } from '@/features/course/course-stages'
import { cn } from '@/lib/utils'
import { NOT_READY_REASON } from './course-nav'

/**
 * Where a course is in setup, in the navigation: "Setup, step 2 of 3", a bar and the name of the step. It stands in for
 * the study pages that are not open yet (they are not listed as dead links), and says in one line what opens them.
 */
export function SetupProgress({ step, className, showReason = true }: { step: 1 | 2 | 3; className?: string; showReason?: boolean }) {
  const stage = COURSE_STAGES[step - 1]
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-control bg-surface-2 px-3 py-2.5', className)} data-testid="setup-progress">
      <p className="flex items-baseline justify-between gap-2 text-small">
        <span className="font-medium text-fg">Setup</span>
        <span className="tabular text-fg-2">
          Step {step} of {COURSE_STAGES.length}
        </span>
      </p>
      <Progress value={(step / COURSE_STAGES.length) * 100} aria-label={`Setup: step ${step} of ${COURSE_STAGES.length}, ${stage.title}`} />
      <p className="text-caption font-normal text-fg-2">{stage.title}</p>
      {showReason ? <p className="text-caption font-normal text-fg-3">{NOT_READY_REASON}</p> : null}
    </div>
  )
}
