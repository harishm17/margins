import { Skeleton, SkeletonField, SkeletonIntro, SkeletonPage } from '@/components/ui/page-skeleton'

/** New course: the intro, the name and description fields, then the two buttons. */
export default function NewCourseLoading() {
  return (
    <SkeletonPage width="narrow">
      <SkeletonIntro />
      <div aria-hidden="true" className="flex flex-col gap-5">
        <SkeletonField labelWidth="w-24" />
        <SkeletonField labelWidth="w-32" height={70} />
        <div className="flex gap-2">
          <Skeleton className="h-[34px] w-32" />
          <Skeleton className="h-[34px] w-20" />
        </div>
      </div>
    </SkeletonPage>
  )
}
