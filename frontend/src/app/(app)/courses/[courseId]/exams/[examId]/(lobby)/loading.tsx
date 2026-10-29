import { Skeleton, SkeletonIntro, SkeletonPage, SkeletonRows, SkeletonSection } from '@/components/ui/page-skeleton'

/** An exam's lobby: title, three facts, the topics it covers, what to expect, Start, past attempts. */
export default function ExamLobbyLoading() {
  return (
    <SkeletonPage width="medium">
      <SkeletonIntro />
      <div aria-hidden="true" className="flex flex-col gap-10">
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-4 border-y border-border py-4 sm:max-w-md">
            {[0, 1, 2].map((item) => (
              <div key={item}>
                <Skeleton className="h-4 w-16 rounded-chip" />
                <Skeleton className="mt-1 h-[22px] w-12 rounded-chip" />
              </div>
            ))}
          </div>
          <div>
            <Skeleton className="h-5 w-14 rounded-chip" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[28, 24, 36, 20].map((width) => (
                <Skeleton key={width} className="h-6 rounded-chip" style={{ width: width * 4 }} />
              ))}
            </div>
          </div>
        </div>
        <SkeletonSection headingWidth="w-36">
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((line) => (
              <Skeleton key={line} className="h-4 w-4/5 rounded-chip" />
            ))}
          </div>
          <Skeleton className="mt-6 h-10 w-28" />
        </SkeletonSection>
        <SkeletonSection headingWidth="w-32">
          <SkeletonRows count={1} lines={1} trailing="w-24" />
        </SkeletonSection>
      </div>
    </SkeletonPage>
  )
}
