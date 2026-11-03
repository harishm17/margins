import Link from 'next/link'
import { ArrowRight } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * A step of the path whose screen is not built yet (the warm-up and recall arrive with their own
 * changes). It is its own route and frame already, so the path, the shortcuts and the next-activity
 * links all land somewhere honest, and says so plainly rather than looking broken.
 */
export function StepPlaceholder({
  icon,
  title,
  description,
  nextHref,
  nextLabel,
}: {
  icon: React.ReactNode
  title: string
  description: string
  nextHref: string
  nextLabel: string
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      action={
        <Button asChild variant="secondary">
          <Link href={nextHref} scroll={false}>
            {nextLabel}
            <ArrowRight aria-hidden="true" className="ml-1 size-4" />
          </Link>
        </Button>
      }
    >
      {description}
    </EmptyState>
  )
}
