import Link from 'next/link'
import { ArrowRight } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import type { ContinueAction } from '@/server/queries/continue'

/**
 * Up next for the course studied most recently. It is the same next step the course overview and
 * the sidebar show (lib/learning/next-step.ts), so the three never disagree.
 */
export function ContinueCard({ data }: { data: ContinueAction }) {
  const { course, step } = data
  const href = step.action?.href ?? `/courses/${course.id}`
  const verb = step.action?.verb ?? 'Open course'
  // A finished day has no step to take: the button is a quiet way into the course.
  const quiet = step.kind === 'clear' && step.action === null
  return (
    <section
      aria-labelledby="continue-heading"
      className="flex flex-col gap-4 rounded-card border border-l-[3px] border-border border-l-accent-soft bg-surface p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <div className="min-w-0">
        <h2 id="continue-heading" className="flex items-baseline gap-2 text-small text-fg-2">
          <span className="font-medium text-accent-soft-fg">Up next</span>
          <Link
            href={`/courses/${course.id}`}
            className="inline-flex min-h-6 items-center truncate rounded-chip hover:text-fg hover:underline max-lg:min-h-11"
          >
            {course.name}
          </Link>
        </h2>
        <p className="mt-1.5 text-heading text-fg sm:truncate">{step.title}</p>
        <p className="mt-1 text-small text-fg-2">
          {step.reason}
          {step.etaLabel && step.kind !== 'clear' ? ` ${step.etaLabel}.` : ''}
          {step.overBudgetLabel ? ` ${step.overBudgetLabel}.` : ''}
        </p>
        {step.exam.label ? <p className="mt-1 text-caption font-normal text-fg-3">{step.exam.label}</p> : null}
      </div>
      <Button asChild variant={quiet ? 'secondary' : 'primary'} size="lg" className="shrink-0 self-start sm:self-center">
        <Link href={href}>
          {verb}
          {quiet ? null : <ArrowRight aria-hidden="true" className="size-4" />}
        </Link>
      </Button>
    </section>
  )
}
