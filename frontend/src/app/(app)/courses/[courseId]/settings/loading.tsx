import { Skeleton, SkeletonField, SkeletonIntro, SkeletonPage } from '@/components/ui/page-skeleton'

/** Course settings: the intro, the four fields, Save, then the delete section. */
export default function SettingsLoading() {
  return (
    <SkeletonPage width="narrow">
      <SkeletonIntro />
      <div aria-hidden="true" className="flex flex-col gap-5">
        <SkeletonField labelWidth="w-24" />
        <SkeletonField labelWidth="w-32" height={92} />
        <SkeletonField labelWidth="w-20" />
        <SkeletonField labelWidth="w-40" />
        <Skeleton className="h-[34px] w-32" />
      </div>
      <div aria-hidden="true" className="mt-12 border-t border-border pt-6">
        <Skeleton className="h-[22px] w-40 rounded-chip" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full rounded-chip" />
        <Skeleton className="mt-4 h-[34px] w-36" />
      </div>
    </SkeletonPage>
  )
}
