import { Skeleton } from '@/components/ui/skeleton'

export default function ReviewSessionLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your review" className="mx-auto w-full max-w-[720px] px-4 pb-16 pt-8 md:px-6">
      <Skeleton className="h-5 w-40 rounded-chip" />
      <Skeleton className="mt-4 h-1" />
      <Skeleton className="mt-8 h-6 w-4/5 rounded-chip" />
      <div className="mt-5 flex flex-col gap-2">
        {[0, 1].map((row) => (
          <Skeleton key={row} className="h-11" />
        ))}
      </div>
    </div>
  )
}
