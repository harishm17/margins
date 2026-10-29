import { Skeleton, SkeletonIntro, SkeletonPage } from '@/components/ui/page-skeleton'

/** Settings: the intro, then four sections (account, AI allowance, theme, delete). */
export default function SettingsLoading() {
  return (
    <SkeletonPage width="narrow" className="pt-8">
      <SkeletonIntro />
      <div aria-hidden="true" className="flex flex-col gap-8">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={index ? 'border-t border-border pt-6' : undefined}>
            <Skeleton className="h-[22px] w-40 rounded-chip" />
            <Skeleton className="mt-4 h-4 w-72 max-w-full rounded-chip" />
            <Skeleton className="mt-3 h-[34px] w-36" />
          </div>
        ))}
      </div>
    </SkeletonPage>
  )
}
