import { Skeleton, SkeletonPage, SkeletonRows, SkeletonSection, SkeletonText } from '@/components/ui/page-skeleton'

/** Results: the score ring and points, where to focus, then the questions. */
export default function ExamResultsLoading() {
  return (
    <SkeletonPage width="medium">
      <div aria-hidden="true" className="flex flex-col gap-12">
        <div className="flex items-center gap-6">
          <Skeleton className="size-24 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-[42px] w-64 max-w-full rounded-chip" />
            <Skeleton className="mt-2 h-4 w-72 max-w-full rounded-chip" />
            <div className="mt-4 flex gap-2">
              <Skeleton className="h-[34px] w-32" />
              <Skeleton className="h-[34px] w-28" />
            </div>
          </div>
        </div>
        <SkeletonSection headingWidth="w-36">
          <SkeletonRows count={3} lines={1} trailing="w-16" className="min-h-[53px]" />
        </SkeletonSection>
        <SkeletonSection headingWidth="w-28">
          <div className="flex flex-col gap-8">
            {[0, 1].map((item) => (
              <div key={item} className="flex gap-3">
                <Skeleton className="size-5 shrink-0 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-5 w-4/5 rounded-chip" />
                  <SkeletonText lines={3} className="mt-4" />
                </div>
              </div>
            ))}
          </div>
        </SkeletonSection>
      </div>
    </SkeletonPage>
  )
}
