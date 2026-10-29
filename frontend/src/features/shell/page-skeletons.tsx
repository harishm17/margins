import { Page } from '@/components/shell/page'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The loading shapes of the pages that read "today": Home, the course overview, the Plan and Review.
 * Each follows the real page's blocks and heights, so the page that replaces it does not move what is
 * already on screen. They are also what the page shows for the first request of a browser whose time
 * zone is not known yet (see server/timezone.ts), so a plan is never drawn for the wrong day first. The
 * root carries a key so React rebuilds the page instead of reusing the skeleton's elements: reused
 * elements that change size count as layout shift.
 */

function Intro({ titleWidth = 'w-24', description = 'w-96' }: { titleWidth?: string; description?: string }) {
  return (
    <div className="mb-8">
      <Skeleton className={`h-8 ${titleWidth} rounded-chip`} />
      <Skeleton className={`mt-1 h-[22px] ${description} max-w-full rounded-chip`} />
    </div>
  )
}

export function HomeSkeleton() {
  return (
    <Page key="loading-shape">
      <div aria-busy="true" aria-label="Loading">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <Skeleton className="h-8 w-64 rounded-chip" />
            <Skeleton className="mt-1 h-[22px] w-44 rounded-chip" />
          </div>
          <Skeleton className="h-[34px] w-32" />
        </div>
        <div className="flex flex-col gap-10">
          <Skeleton className="h-[116px] rounded-card" />
          <div>
            <Skeleton className="h-6 w-40 rounded-chip" />
            <div className="mt-3 flex flex-col gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          </div>
          <div>
            <Skeleton className="h-6 w-24 rounded-chip" />
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-[148px] rounded-card" />
              <Skeleton className="h-[148px] rounded-card" />
              <Skeleton className="h-[148px] rounded-card" />
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}

export function OverviewSkeleton() {
  return (
    <Page key="loading-shape">
      <div aria-busy="true" aria-label="Loading">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <Skeleton className="h-8 w-56 rounded-chip" />
            <Skeleton className="mt-1 h-[22px] w-72 max-w-full rounded-chip" />
          </div>
          <div className="flex gap-2 max-sm:hidden">
            <Skeleton className="h-[34px] w-16" />
            <Skeleton className="h-[34px] w-28" />
            <Skeleton className="h-[34px] w-[34px]" />
          </div>
        </div>
        <div className="flex flex-col gap-10">
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <Skeleton className="h-[172px] rounded-card" />
            <Skeleton className="h-[178px] rounded-card" />
          </div>
          <div>
            <Skeleton className="h-[26px] w-24 rounded-chip" />
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-[142px] rounded-card" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}

/** A plan: the heading, "This week" with today and the days after it open, then lines for the days that follow. */
export function PlanSkeleton() {
  return (
    <Page key="loading-shape">
      <div aria-busy="true" aria-label="Loading">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-8 w-24 rounded-chip" />
            <Skeleton className="mt-1 h-[22px] w-96 max-w-full rounded-chip" />
          </div>
          <Skeleton className="h-[34px] w-44 max-sm:hidden" />
        </div>
        <div className="mt-6 flex flex-col gap-10">
          <div>
            <Skeleton className="mb-3 h-[26px] w-32 rounded-chip" />
            <div className="flex flex-col gap-3">
              <Skeleton className="h-[200px] rounded-card" />
              <Skeleton className="h-[140px] rounded-card" />
              <Skeleton className="h-[140px] rounded-card" />
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-11 rounded-card" />
              ))}
            </div>
          </div>
          <div>
            <Skeleton className="mb-3 h-[26px] w-40 rounded-chip" />
            <div className="flex flex-col gap-3">
              {Array.from({ length: 7 }, (_, index) => (
                <Skeleton key={index} className="h-11 rounded-card" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}

export function ReviewSkeleton() {
  return (
    <Page key="loading-shape">
      <div aria-busy="true" aria-label="Loading">
        <Intro titleWidth="w-28" description="w-80" />
        <div className="flex flex-col gap-10">
          <div>
            <Skeleton className="h-[26px] w-44 rounded-chip" />
            <Skeleton className="mt-1 h-5 w-96 max-w-full rounded-chip" />
            <div className="mt-3 flex flex-col gap-3">
              <Skeleton className="h-[130px] rounded-card" />
              <Skeleton className="h-[130px] rounded-card" />
              <Skeleton className="h-[130px] rounded-card" />
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}
