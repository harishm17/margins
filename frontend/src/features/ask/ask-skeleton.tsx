import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

/** The Ask layout while its code loads: thread list, a question, an answer and the composer. */
export function AskPageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex h-[calc(100dvh-var(--topbar-height)-var(--tabbar-height,0px)-var(--ai-banner-height,0px))] min-h-0">
      <h1 className="sr-only">Ask your materials</h1>
      <aside className="hidden w-[248px] shrink-0 border-r border-border bg-surface p-3 lg:block">
        <Skeleton className="h-[34px]" />
        <div className="mt-5 flex flex-col gap-2 px-1">
          <Skeleton className="h-3 w-12 rounded-chip" />
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-8 px-4 py-6 md:px-6">
          <Skeleton className="ml-auto h-10 w-2/3 rounded-card" />
          <SkeletonText lines={5} />
        </div>
        <div className="mx-auto w-full max-w-[720px] px-4 pb-6 md:px-6">
          <Skeleton className="h-[84px] rounded-card" />
        </div>
      </div>
    </div>
  )
}
