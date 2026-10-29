import { SkeletonIntro, SkeletonPage, SkeletonRows } from '@/components/ui/page-skeleton'

/** Mock exams: the intro with New mock exam, then the exam rows. */
export default function ExamsLoading() {
  return (
    <SkeletonPage>
      <SkeletonIntro actions="w-36" />
      <SkeletonRows count={2} trailing="w-28" className="min-h-[76px]" />
    </SkeletonPage>
  )
}
