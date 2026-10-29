import * as React from 'react'
import { cn } from '@/lib/utils'

const WIDTHS = {
  default: 'max-w-[1120px]',
  /** One reading column: the mock exam pages (new, lobby, results). */
  medium: 'max-w-[784px]',
  /** A centred 520px column for short forms (new course, course settings). */
  narrow: 'max-w-[584px]',
} as const

/**
 * The page container: padded 32 / 24 / 16 by screen size, with the same top padding at every width,
 * so the h1 sits at the same height on every page. Pick a width here; don't override the padding or
 * the max width with classes.
 */
export function Page({
  children,
  width = 'default',
  className,
}: {
  children: React.ReactNode
  width?: keyof typeof WIDTHS
  className?: string
}) {
  return (
    <div className={cn('mx-auto w-full px-4 pb-16 pt-4 md:px-6 lg:px-8', WIDTHS[width], className)}>
      {children}
    </div>
  )
}

/** The page's h1 with an optional line under it and actions on the right. */
export function PageIntro({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-4', className)}>
      <div className="min-w-0">
        <h1 className="text-title text-fg">{title}</h1>
        {description ? <p className="mt-1 text-body text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
