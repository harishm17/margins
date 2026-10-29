import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowsClockwise, Microphone } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ReviewList } from '@/features/review/review-list'
import { getReviewPageData } from '@/server/queries/review'
import { describeSprintTopics, getSprintTopics } from '@/server/queries/voice'
import { requireUser } from '@/server/session'
import { ReviewSkeleton } from '@/features/shell/page-skeletons'
import { getTimeZoneState } from '@/server/timezone'

export const metadata: Metadata = { title: 'Review' }

export default async function ReviewPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const { timeZone, known } = await getTimeZoneState()
  if (!known) return <ReviewSkeleton />
  const data = await getReviewPageData(user.id, courseId, timeZone)
  if (!data) notFound()
  const sprint = await getSprintTopics(user.id, courseId)

  return (
    <Page>
      <PageIntro title="Review" description="Go over the topics that are due, most overdue first." />
      {!data.hasTopics ? (
        <EmptyState
          icon={<ArrowsClockwise />}
          title="No topics to review yet"
          action={
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/topics`}>Go to topics</Link>
            </Button>
          }
        >
          Reviews start after you take a quiz. Add your materials and confirm the topics first.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          <ReviewList data={data} />
          {sprint.topics.length > 0 ? (
            // The session itself has its own screen: it runs full height and does not scroll under this list.
            <section
              aria-labelledby="voice-heading"
              className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <h2 id="voice-heading" className="text-heading text-fg">
                  Voice practice
                </h2>
                <p className="mt-1 text-small text-fg-2">{describeSprintTopics(sprint.topics, sprint.studied)}</p>
              </div>
              <Button asChild variant="secondary" icon={<Microphone />} className="shrink-0 self-start sm:self-center">
                <Link href={`/courses/${courseId}/review/voice`}>Start voice practice</Link>
              </Button>
            </section>
          ) : null}
        </div>
      )}
    </Page>
  )
}
