import { Page } from '@/components/shell/page'
import { Skeleton } from '@/components/ui/skeleton'

export default function MapLoading() {
  return (
    <Page key="loading-shape">
      <div aria-busy="true" aria-label="Loading">
        <div className="mb-8">
          <Skeleton className="h-8 w-20 rounded-chip" />
          <Skeleton className="mt-1 h-[22px] w-96 max-w-full rounded-chip" />
        </div>
        <Skeleton className="h-[34px] w-72 max-w-full rounded-control" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Skeleton className="h-[420px] rounded-card" />
          <Skeleton className="hidden h-[320px] rounded-card lg:block" />
        </div>
      </div>
    </Page>
  )
}
