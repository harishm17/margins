'use client'

import * as React from 'react'
import { WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/** The body of every error.tsx: a calm message and a retry button. */
export function ErrorPanel({
  error,
  reset,
  title = 'Something went wrong',
  className,
}: {
  error: Error & { digest?: string }
  reset: () => void
  title?: string
  className?: string
}) {
  React.useEffect(() => {
    console.error(error)
  }, [error])

  // An alert, so a screen reader says the page failed instead of leaving silence where the page was.
  return (
    <div role="alert">
      <EmptyState
        className={className}
        icon={<WarningCircle />}
        title={title}
        action={
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
        }
      >
        This page could not load. Try again, and if it keeps happening, reload the page.
      </EmptyState>
    </div>
  )
}
