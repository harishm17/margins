import { Skeleton, SkeletonField, SkeletonIntro, SkeletonPage } from '@/components/ui/page-skeleton'

/** The new mock exam form: topic checkboxes, then four single-choice rows, then Create. */
export default function NewExamLoading() {
  return (
    <SkeletonPage width="medium">
      <SkeletonIntro />
      <div aria-hidden="true" className="flex flex-col gap-8">
        <div>
          <Skeleton className="h-4 w-14 rounded-chip" />
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3, 4].map((item) => (
              <Skeleton key={item} className="h-11 rounded-control" />
            ))}
          </div>
        </div>
        <SkeletonField labelWidth="w-20" height={34} />
        <SkeletonField labelWidth="w-20" height={34} />
        <SkeletonField labelWidth="w-20" height={34} />
        <SkeletonField labelWidth="w-24" height={34} />
        <div className="flex gap-2 border-t border-border pt-6">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-20" />
        </div>
      </div>
    </SkeletonPage>
  )
}
