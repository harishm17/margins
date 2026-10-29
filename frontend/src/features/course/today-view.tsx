import Link from 'next/link'
import { ArrowRight, ChatCircleText, Exam } from '@phosphor-icons/react/dist/ssr'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Page, PageIntro } from '@/components/shell/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ProgressRing } from '@/components/ui/progress-ring'
import { DueLabel, RelativeTime } from '@/components/ui/relative-time'
import {
  masteryLabel,
  masteryLevel,
  masteryPercent,
  masteryTone,
  type MasteryCounts,
  type MasteryLevel,
} from '@/lib/mastery'
import { cn } from '@/lib/utils'
import type { TodayData, TodayTopic } from '@/server/queries/course'
import type { CourseShell } from '@/server/queries/courses'
import { BuildingContent } from './building-content'
import { CourseMenu } from './course-menu'
import { ExamPromptCard } from './exam-prompt-card'
import { RefreshOnFocus } from './refresh-on-focus'
import { newTopicsLabel } from '@/lib/course-setup'
import { courseSummary } from './summary'

/**
 * The one card that says what to do next. It reads `TodayData.next`, the same step the home page's
 * Continue card and the sidebar badge are derived from (lib/learning/next-step.ts).
 */
function UpNext({ courseId, next }: { courseId: string; next: TodayData['next'] }) {
  const planHref = `/courses/${courseId}/plan`
  const reviewHref = `/courses/${courseId}/review`
  // "Done for today" and "all caught up" end in a quiet button; everything else has a real next step.
  const hasStep = next.action !== null && next.kind !== 'clear'
  return (
    <Card aria-labelledby="up-next-heading" role="region" className="flex flex-col gap-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 id="up-next-heading" className="text-small font-medium text-accent-soft-fg">
            Up next
          </h2>
          <Link
            href={planHref}
            className="inline-flex min-h-6 items-center rounded-chip text-small text-fg-2 underline-offset-[3px] hover:text-fg hover:underline max-lg:min-h-11"
          >
            See the plan
          </Link>
        </div>
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <p className="text-heading text-fg">{next.title}</p>
            <p className="mt-1 text-small text-fg-2">{next.reason}</p>
            {next.etaLabel || next.partLabel ? (
              <p className="mt-1 text-caption font-normal text-fg-3">
                {[next.partLabel, next.etaLabel].filter(Boolean).join(', ')}
              </p>
            ) : null}
            {next.overBudgetLabel ? (
              <Badge tone="warning" className="mt-1.5">
                {next.overBudgetLabel}
              </Badge>
            ) : null}
          </div>
          {next.action ? (
            <Button
              asChild
              variant={hasStep ? 'primary' : 'secondary'}
              size="lg"
              className="shrink-0 self-start"
              icon={next.kind === 'clear' ? <Exam /> : undefined}
            >
              <Link href={next.action.href}>
                {next.action.verb}
                {hasStep ? <ArrowRight aria-hidden="true" className="size-4" /> : null}
              </Link>
            </Button>
          ) : null}
        </div>
        {next.kind === 'work' && next.deferredDue > 0 ? (
          <p className="mt-3 text-small text-fg-2">
            {next.deferredDue === 1 ? '1 more review is' : `${next.deferredDue} more reviews are`} due and not in today&apos;s plan, so{' '}
            {next.deferredDue === 1 ? 'it comes' : 'they come'} first tomorrow.{' '}
            <Link href={reviewHref} className="rounded-chip text-fg underline underline-offset-[3px]">
              Open Review
            </Link>
          </p>
        ) : null}
        {next.kind === 'reviews_due' && next.dueCount > 1 ? (
          <p className="mt-3 text-small text-fg-2">
            <Link href={reviewHref} className="rounded-chip text-fg underline underline-offset-[3px]">
              See all {next.dueCount} due reviews
            </Link>
          </p>
        ) : null}
        {next.kind === 'work' && (next.doneToday > 0 || next.minutesLeft > 0) ? (
          <p className="mt-3 text-caption font-normal tabular text-fg-3">
            {next.doneToday > 0 ? `${next.doneToday} done today, ` : ''}
            about {next.minutesLeft} min to go
          </p>
        ) : null}
      </div>
      {next.then.length > 0 ? (
        <div className="border-t border-border pt-3">
          <h3 className="px-2 text-caption text-fg-3">Then</h3>
          <ul className="mt-1">
            {next.then.map((action) => (
              <li key={action.id}>
                <Link
                  href={action.href}
                  className="flex min-h-11 items-center gap-3 rounded-control px-2 py-2 transition-colors duration-120 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-fg">{action.title}</span>
                  <span className="shrink-0 text-caption font-normal text-fg-3">{action.etaLabel}</span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {next.exam.short && next.exam.shortMessage ? (
        <InlineAlert
          tone="warning"
          title="Time is short"
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={planHref}>See the plan</Link>
            </Button>
          }
        >
          {next.exam.shortMessage.replace(/^Time is short\.\s*/, '')}
        </InlineAlert>
      ) : null}
    </Card>
  )
}

const BUCKETS: { level: MasteryLevel; label: string; swatch: string }[] = [
  { level: 'strong', label: 'Strong', swatch: 'bg-accent' },
  { level: 'getting', label: 'Getting there', swatch: 'bg-accent/50' },
  { level: 'learning', label: 'Learning', swatch: 'bg-learning' },
  { level: 'none', label: 'Not started', swatch: 'bg-surface-3' },
]

function ProgressCard({ average, counts }: { average: number | null; counts: MasteryCounts }) {
  const percent = masteryPercent(average)
  return (
    <Card aria-labelledby="progress-heading" role="region" className="flex flex-col gap-4">
      <h2 id="progress-heading" className="text-small font-medium text-fg-2">
        Course mastery
      </h2>
      <div className="flex items-center gap-5">
        <ProgressRing
          size={96}
          value={average}
          label={percent === null ? '--' : `${percent}%`}
          aria-label={percent === null ? 'Course mastery: not started' : `Course mastery: ${percent}%`}
        />
        <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-3">
          {BUCKETS.map((bucket) => (
            <div key={bucket.level} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-caption font-normal text-fg-2">
                <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-[2px]', bucket.swatch)} />
                <span className="whitespace-nowrap">{bucket.label}</span>
              </dt>
              <dd className="mt-0.5 text-heading tabular text-fg">{counts[bucket.level]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  )
}

function TopicTile({ courseId, topic }: { courseId: string; topic: TodayTopic }) {
  const level = masteryLevel(topic.mastery)
  const percent = masteryPercent(topic.mastery)
  return (
    <Card interactive asChild compact className="flex h-full flex-col gap-3">
      <Link href={`/courses/${courseId}/topics/${topic.id}`}>
        <div className="flex items-center gap-2">
          <ProgressRing
            size={28}
            value={level === 'none' ? null : topic.mastery}
            tone={masteryTone(level) === 'warning' ? 'warning' : 'accent'}
          />
          <span className="text-small tabular text-fg-2">{percent === null ? '--' : `${percent}%`}</span>
        </div>
        <p className="line-clamp-2 min-h-10 text-body-strong text-fg">{topic.name}</p>
        {topic.due && topic.dueAt ? (
          <DueLabel dueAt={topic.dueAt} className="text-caption font-normal" />
        ) : (
          <p className="text-caption font-normal text-fg-3">{masteryLabel(topic.mastery)}</p>
        )}
      </Link>
    </Card>
  )
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <Badge>Grading</Badge>
  const tone = score >= 80 ? 'accent' : score < 50 ? 'warning' : 'neutral'
  return (
    <Badge tone={tone} className="tabular">
      {Math.round(score)}%
    </Badge>
  )
}

function RecentExams({ courseId, exams }: { courseId: string; exams: TodayData['recentExams'] }) {
  return (
    <section aria-labelledby="exams-heading">
      <h2 id="exams-heading" className="text-heading text-fg">
        Recent mock exams
      </h2>
      {exams.length === 0 ? (
        <p className="mt-2 text-small text-fg-2">Take a timed mock exam when you feel ready.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {exams.map((exam) => (
            <li key={exam.submissionId} className="flex min-h-12 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-strong text-fg">{exam.name}</p>
                <p className="text-caption font-normal text-fg-3">
                  Taken <RelativeTime date={exam.submittedAt} />
                </p>
              </div>
              <ScoreBadge score={exam.score} />
              <Button asChild size="sm" variant="secondary">
                <Link href={`/courses/${courseId}/exams/${exam.examId}/results/${exam.submissionId}`}>Results</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button asChild variant="secondary" className="mt-3" icon={<Exam />}>
        <Link href={`/courses/${courseId}/exams/new`}>New mock exam</Link>
      </Button>
    </section>
  )
}

/** The active course: what to do next, progress, topics, recent exams, content being built. */
export function TodayView({ course, today }: { course: CourseShell; today: TodayData }) {
  const base = `/courses/${course.id}`
  const building = today.generation.activeJobs > 0 || today.generation.failures.length > 0
  const newTopics = newTopicsLabel(course.setup.topics)

  return (
    <Page>
      <RefreshOnFocus />
      <PageIntro
        title={course.name}
        description={courseSummary(today.topicCount, today.counts, today.next.dueCount, today.next.exam.label)}
        actions={
          <>
            <Button asChild variant="secondary" icon={<ChatCircleText />}>
              <Link href={`${base}/ask`}>Ask</Link>
            </Button>
            <Button asChild variant="secondary" icon={<Exam />}>
              <Link href={`${base}/exams`}>Mock exam</Link>
            </Button>
            <CourseMenu courseId={course.id} topicsToPrepare={today.topicsToPrepare} />
          </>
        }
      />

      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          {newTopics ? (
            <InlineAlert
              tone="accent"
              title={newTopics}
              action={
                <Button asChild size="sm" variant="primary">
                  <Link href={`${base}/topics?edit=1`}>Review topics</Link>
                </Button>
              }
            >
              They join your plan once you confirm them.
            </InlineAlert>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <UpNext courseId={course.id} next={today.next} />
            <ProgressCard average={today.averageMastery} counts={today.counts} />
          </div>
          {today.examPrompt ? <ExamPromptCard courseId={course.id} /> : null}
        </div>

        <section aria-labelledby="topics-heading">
          <div className="flex items-center justify-between gap-4">
            <h2 id="topics-heading" className="text-heading text-fg">
              Topics
            </h2>
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/topics`}>View all</Link>
            </Button>
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {today.tiles.map((topic) => (
              <li key={topic.id}>
                <TopicTile courseId={course.id} topic={topic} />
              </li>
            ))}
          </ul>
        </section>

        <div className={cn('grid items-start gap-10', building && 'lg:grid-cols-2 lg:gap-6')}>
          <RecentExams courseId={course.id} exams={today.recentExams} />
          {building ? <BuildingContent courseId={course.id} generation={today.generation} /> : null}
        </div>
      </div>
    </Page>
  )
}
