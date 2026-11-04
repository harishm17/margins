import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Three named widths, and one rule for which page gets which. The numbers are the content width, on a
 * laptop; the container adds the page padding (32px from the lg breakpoint).
 *
 *  - wide  (1056): a page that lays out several things side by side or lists many rows: Home with courses,
 *    course overview, Plan, Topics, Materials, Map, Review, Mock exams list, the topic editor.
 *  - focus (720): one reading column with one job: the welcome page, course setup, a mock exam's new, lobby
 *    and results pages, the not-found and error pages.
 *  - form  (640): a page that is one short form: New course, Course settings, Account settings.
 *
 * Every width starts at the same left edge (the narrower ones sit left inside the wide frame, they are not
 * centred), so the title stays put when the student moves from one page to the next. `default`, `medium`
 * and `narrow` are the old names, kept so a page not yet moved keeps working: they map to wide, focus and form.
 */
const WIDTHS = {
  wide: '',
  focus: 'max-w-[720px]',
  form: 'max-w-[640px]',
  default: '',
  medium: 'max-w-[720px]',
  narrow: 'max-w-[640px]',
} as const

/**
 * The page container: padded 32 / 24 / 16 by screen size, with the same top padding at every width,
 * so the h1 sits at the same height on every page. Pick a width here; don't override the padding or
 * the max width with classes.
 */
export function Page({
  children,
  width = 'wide',
  className,
}: {
  children: React.ReactNode
  width?: keyof typeof WIDTHS
  className?: string
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1120px] px-4 pb-16 pt-4 md:px-6 lg:px-8', className)}>
      <div className={cn('w-full', WIDTHS[width])}>{children}</div>
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
        {description ? <p className="mt-1 max-w-[68ch] text-body text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
