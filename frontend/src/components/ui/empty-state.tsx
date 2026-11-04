import * as React from 'react'
import { cn } from '@/lib/utils'

type EmptyStateProps = {
  /** A 20px icon element: icon={<BookOpenText />}. */
  icon: React.ReactNode
  title: string
  /** One or two lines of text, 52 characters wide at most. */
  children?: React.ReactNode
  /** The one primary action. */
  action?: React.ReactNode
  /** A quieter second option, usually a link. */
  secondary?: React.ReactNode
  /** The title is a level-2 heading; a page that has nothing else on it (a 404) makes it the h1. */
  as?: 'h1' | 'h2'
  className?: string
}

export function EmptyState({ icon, title, children, action, secondary, as: Heading = 'h2', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-4 py-12 text-center', className)}>
      <div
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-card bg-surface-2 text-fg-2 [&>svg]:size-5"
      >
        {icon}
      </div>
      <Heading className="mt-4 text-subheading text-fg">{title}</Heading>
      {children ? <div className="mt-1.5 max-w-[52ch] wrap-anywhere text-small text-fg-2">{children}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
      {secondary ? <div className="mt-3 text-small">{secondary}</div> : null}
    </div>
  )
}
