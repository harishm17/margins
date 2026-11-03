'use client'

import dynamic from 'next/dynamic'
import { Skeleton, SkeletonText } from './skeleton'

/**
 * Markdown loads as its own chunk, only where it is used. The server still renders it into the
 * first response, so there is no empty flash; the skeleton covers client-side navigation.
 */
export const LazyMarkdown = dynamic(() => import('./markdown').then((m) => m.Markdown), {
  loading: () => (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton className="h-6 w-2/5 rounded-chip" />
      <SkeletonText lines={4} />
    </div>
  ),
})

/** A "Check yourself" block outside markdown (the gap explainer's), sharing the markdown chunk. */
export const LazyCheckYourself = dynamic(() => import('./markdown').then((m) => m.CheckYourself), {
  loading: () => <Skeleton className="h-28 w-full rounded-card" aria-hidden="true" />,
})

export const LazyMarkdownInline = dynamic(() => import('./markdown').then((m) => m.MarkdownInline), {
  loading: () => null,
})
