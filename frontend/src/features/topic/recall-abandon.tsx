'use client'

import * as React from 'react'
import { markRecallAbandoned } from './recall-draft'

/**
 * Rendered with the reader and the explainer. Opening either while a recall card is open means the answer is no
 * longer given with the book closed, so every open card of the topic is marked: its answer is then sent as level 2
 * (spec §5.3). Renders nothing.
 */
export function RecallAbandonOnOpen({ topicId }: { topicId: string }) {
  React.useEffect(() => {
    try {
      markRecallAbandoned(window.sessionStorage, topicId)
    } catch {
      // Storage may be blocked: the card then counts as it was.
    }
  }, [topicId])
  return null
}
