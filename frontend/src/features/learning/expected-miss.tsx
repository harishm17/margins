'use client'

import * as React from 'react'
import { expectedMissText } from './expected-miss-copy'
import { markExpectedMissShown, shouldShowExpectedMiss, type ExpectedMissSurface } from './expected-miss-rules'

export { shouldShowExpectedMiss, type ExpectedMissSurface }

/**
 * One short line that says missing is expected, under the feedback where the miss happened (spec §18.10).
 * It shows at most once per surface per local day and never as a toast. Put it inside the feedback's live
 * region so it is read out with the feedback; it adds no live region of its own.
 *
 * `summaryMissedShare` (0 to 1) is for the summary surfaces. `page` fills the page in the "no step solved" line.
 */
export function ExpectedMiss({
  surface,
  summaryMissedShare,
  page,
}: {
  surface: ExpectedMissSurface
  summaryMissedShare?: number
  page?: number | null
}) {
  const [show, setShow] = React.useState(false)
  // Strict mode runs the effect twice; the second run would find the line already marked as shown.
  const decided = React.useRef(false)

  React.useEffect(() => {
    if (decided.current) return
    decided.current = true
    let storage: Storage
    try {
      storage = window.sessionStorage
    } catch {
      return
    }
    const now = new Date()
    if (!shouldShowExpectedMiss(surface, now, storage, summaryMissedShare)) return
    markExpectedMissShown(surface, now, storage)
    // Storage is only readable in the browser, so the line appears after hydration, not in the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShow(true)
  }, [surface, summaryMissedShare])

  if (!show) return null
  return <p className="text-small text-fg-2">{expectedMissText(surface, { page })}</p>
}
