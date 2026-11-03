import Link from 'next/link'
import { CheckCircle, Play } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { DueLabel } from '@/components/ui/relative-time'
import { formatDate, pluralize } from '@/lib/format'
import { fadeNote as describeFade } from '@/lib/learning/consequence'
import { reviewSessionHref } from '@/lib/learning/review-links'
import type { ActiveSession } from '@/lib/learning/review-session'
import { ReviewActions } from '@/features/topic/review-actions'
import type { ReviewPageData, ReviewTopic } from '@/server/queries/review'

/** The topic is the first on the list, so its button is the one filled button on the page. */
function DueCard({ courseId, topic, first }: { courseId: string; topic: ReviewTopic; first: boolean }) {
  const headingId = `review-title-${topic.id}`
  const fade = describeFade({ earned: topic.earnedMastery, shown: topic.mastery, daysLate: topic.daysLate })
  return (
    <li
      id={`review-${topic.id}`}
      aria-labelledby={headingId}
      className="scroll-mt-24 rounded-card border border-border bg-surface p-4 target:border-accent target:ring-1 target:ring-accent/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <h3 id={headingId} className="min-w-0 text-body-strong text-fg">
          <Link
            href={`/courses/${courseId}/topics/${topic.id}`}
            className="inline-flex min-h-6 items-center rounded-chip hover:underline max-sm:min-h-11"
          >
            {topic.name}
          </Link>
        </h3>
        <DueLabel dueAt={topic.dueAt} className="text-small max-sm:pb-1" />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-fg-2">
        <MasteryIndicator mastery={topic.mastery} showPercent className="text-small" />
        <span>
          {topic.missedCount > 0
            ? `You missed ${pluralize(topic.missedCount, 'question')} lately.`
            : 'No missed questions to retry.'}
        </span>
      </div>
      {fade ? <p className="mt-1 text-caption font-normal text-fg-3">{fade}</p> : null}
      <div className="mt-3">
        <ReviewActions
          courseId={courseId}
          topicId={topic.id}
          missedCount={topic.missedCount}
          retryOpensAt={topic.retryOpensAt}
          topicName={topic.name}
          size="sm"
          emphasis={first}
        />
      </div>
    </li>
  )
}

/**
 * "Start today's review" (spec §7.4): up to 12 questions on the concepts that are due, mixed across the
 * course's topics, then a fresh question on each miss. It is the page's main action.
 */
function SessionCard({ courseId, dueConceptCount, active }: { courseId: string; dueConceptCount: number; active: ActiveSession | null }) {
  // A review already under way today is gone on with, not started again (spec 18.7).
  const resumeHref = active ? `${reviewSessionHref(courseId, { topicId: active.topicId })}${active.topicId ? '&' : '?'}session=${encodeURIComponent(active.sessionId)}` : null
  return (
    <section
      aria-labelledby="session-heading"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <h2 id="session-heading" className="text-heading text-fg">
          Today&apos;s review
        </h2>
        <p className="mt-1 text-small text-fg-2">
          {dueConceptCount > 0
            ? `${pluralize(dueConceptCount, 'idea')} to bring back, mixed across your topics. A fresh question follows each one you miss.`
            : 'You started a review today. Pick up where you left off.'}
        </p>
      </div>
      <Button asChild variant="primary" icon={<Play weight="fill" />} className="shrink-0 self-start sm:self-center">
        {active && resumeHref ? (
          <Link href={resumeHref}>
            Resume {active.short ? 'your short review' : "today's review"} ({active.answered} of {active.total})
          </Link>
        ) : (
          <Link href={reviewSessionHref(courseId)}>Start today&apos;s review</Link>
        )}
      </Button>
    </section>
  )
}

/**
 * The topics due for review, each with "Retry what you missed" (when there is something to retry) and
 * "Fix it now". "Start today's review" is the one filled button on the page when concepts are due; the
 * topic buttons are outlined. Without it (a course from before concepts) the first topic's main action
 * is filled, so the most overdue topic is where to start.
 */
export function ReviewList({ data, active = null }: { data: ReviewPageData; active?: ActiveSession | null }) {
  const courseId = data.course.id
  const next = data.upcoming[0]
  // Concepts due, or a session already started today that is still open.
  const hasSession = data.dueConceptCount > 0 || active !== null
  // Concepts due but no topic due (a surrendered step, say): the session card alone is the answer.
  const showDue = !hasSession || data.due.length > 0
  return (
    <div className="flex flex-col gap-10">
      {hasSession ? <SessionCard courseId={courseId} dueConceptCount={data.dueConceptCount} active={active} /> : null}
      {showDue ? (
        <section aria-labelledby="due-heading">
          <h2 id="due-heading" className="text-heading text-fg">
            Due for review <span className="tabular text-fg-2">({data.due.length})</span>
          </h2>
          {data.due.length > 0 ? (
            <>
              <p className="mt-1 text-small text-fg-2">
                Most overdue first. Score 70% or more and the next review moves out; below that it comes back tomorrow.
              </p>
              <ul className="mt-3 flex flex-col gap-3">
                {data.due.map((topic, index) => (
                  <DueCard key={topic.id} courseId={courseId} topic={topic} first={index === 0 && !hasSession} />
                ))}
              </ul>
            </>
          ) : (
            <div className="mt-3 flex items-start gap-3 rounded-card border border-border bg-surface p-4">
              <CheckCircle aria-hidden="true" weight="fill" className="mt-0.5 size-5 shrink-0 text-accent" />
              <div>
                <h3 className="text-body-strong text-fg">Nothing is due</h3>
                <p className="mt-0.5 text-small text-fg-2">
                  {next
                    ? `Your next review is ${next.name}, on ${formatDate(next.dueAt)}.`
                    : 'Reviews appear here a few days after you take a quiz.'}
                </p>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {data.upcoming.length > 0 ? (
        <section aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading" className="text-heading text-fg">
            Coming up
          </h2>
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {data.upcoming.map((topic) => (
              <li key={topic.id} id={`review-${topic.id}`} className="flex min-h-12 items-center gap-3 py-1 max-sm:min-h-14">
                <MasteryIndicator mastery={topic.mastery} variant="ring" />
                <Link
                  href={`/courses/${courseId}/topics/${topic.id}?view=quiz`}
                  className="inline-flex min-h-6 min-w-0 flex-1 items-center truncate rounded-chip text-body-strong text-fg hover:underline max-sm:min-h-11"
                >
                  {topic.name}
                </Link>
                <time dateTime={topic.dueAt} suppressHydrationWarning className="shrink-0 text-small text-fg-3">
                  {formatDate(topic.dueAt)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
