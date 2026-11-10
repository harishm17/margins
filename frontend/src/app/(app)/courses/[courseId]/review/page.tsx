import { logServerError } from '@/lib/ops/log'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowsClockwise, Microphone } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ShortSessionCard } from '@/features/home/short-session-card'
import { ProgressPanel, WeeklyFocus } from '@/features/review/progress-panel'
import { KeepStudying } from '@/features/review/keep-studying'
import { ReviewList, UpcomingReviews } from '@/features/review/review-list'
import { activeSession } from '@/lib/learning/review-session'
import { REVIEW_EXTRAS_LOCKED_TEXT, hasFirstQuizOrRecall, shortSessionOffer } from '@/lib/learning/short-session-server'
import { getProgress } from '@/server/queries/progress'
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
  // The progress figures are an extra: if they cannot be read the list and the sessions still open.
  // The extras (the 10-minute check, voice practice) are for a student who has something to go over: not before a first quiz or recall.
  const unlocked = data.hasTopics ? await hasFirstQuizOrRecall(user.id, courseId).catch(() => false) : false
  const [sprint, progress, active, short] = await Promise.all([
    unlocked ? getSprintTopics(user.id, courseId) : { topics: [], studied: false },
    data.hasTopics
      ? getProgress(user.id, courseId, { timeZone }).catch((error) => {
          logServerError('Review: Progress could not be read', error)
          return null
        })
      : null,
    // A review started today and not finished: the page offers to resume it (spec 18.7).
    activeSession(user.id, courseId, timeZone).catch(() => null),
    // Quick practice (spec 18.8): an extra, so a failure to work it out leaves the page as it was.
    unlocked ? shortSessionOffer(user.id, courseId, timeZone).catch(() => null) : null,
  ])

  const nothingDue = data.dueConceptCount === 0 && data.due.length === 0 && active === null
  const voiceCard =
    sprint.topics.length > 0 ? (
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
    ) : null
  const lockedNote = !unlocked ? (
    <p className="text-small text-fg-2" data-testid="review-extras-locked">
      {REVIEW_EXTRAS_LOCKED_TEXT}
    </p>
  ) : null
  const hasExtras = !!short || (!!progress && progress.focus.length > 0) || !!voiceCard || data.upcoming.length > 0 || !!progress
  return (
    <Page width="wide">
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
          {nothingDue ? (
            <>
              {/* Nothing is due: the page says so, gives the next date, and keeps everything else behind one closed "Keep studying" so due work and optional practice are not mixed up. */}
              <ReviewList data={data} active={active} omitUpcoming />
              {lockedNote}
              {hasExtras ? (
                <KeepStudying>
                  {short ? <ShortSessionCard courseId={courseId} plan={short.plan} /> : null}
                  {progress ? <WeeklyFocus courseId={courseId} focus={progress.focus} optional /> : null}
                  {voiceCard}
                  <UpcomingReviews courseId={courseId} upcoming={data.upcoming} />
                  {progress ? <ProgressPanel progress={progress} /> : null}
                </KeepStudying>
              ) : null}
            </>
          ) : (
            <>
              {progress ? <WeeklyFocus courseId={courseId} focus={progress.focus} /> : null}
              <ReviewList data={data} active={active} />
              {short ? <ShortSessionCard courseId={courseId} plan={short.plan} /> : null}
              {lockedNote}
              {voiceCard}
              {progress ? <ProgressPanel progress={progress} /> : null}
            </>
          )}
        </div>
      )}
    </Page>
  )
}
