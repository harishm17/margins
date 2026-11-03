'use client'

import { useSearchParams } from 'next/navigation'
import { parseView, type ViewId } from './types'

/** The view named by ?view=. The page redirects to a valid one, so the fallback is rarely seen. */
export function useTopicView(): ViewId {
  return parseView(useSearchParams().get('view')) ?? 'read'
}
