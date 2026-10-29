import Link from 'next/link'
import { ArrowRight, CalendarCheck, CaretDown, CaretRight, Check, Circle, Gear } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { InlineAlert } from '@/components/ui/inline-alert'
import { weekStart, type Plan, type PlanDay } from '@/lib/learning/plan'
import {
  dayLabel,
  daySummary,
  describePlanItem,
  reviewsNotScheduledText,
  tooLongText,
  weekLabel,
  type DescribeContext,
  type DescribedPlanItem,
} from '@/lib/learning/plan-copy'
import { minutesLabel } from '@/lib/learning/plan-settings'
import { cn } from '@/lib/utils'
import { pluralize } from '@/lib/format'

/**
 * How much of the plan is open. Today and the two days after it show their items. Every later day is
 * one line that opens. The weeks between the first two and the last two before an exam fold into one
 * line each, so a plan for a distant exam is a short page rather than a long one. Nothing is hidden
 * for good: every line opens, and the plan itself is unchanged.
 */
export const OPEN_DAYS = 3
const FIRST_WEEKS_SHOWN = 2
const LAST_WEEKS_SHOWN = 2

type Week = { start: string; days: PlanDay[] }

/** Days grouped into weeks that start on Monday. */
export function groupWeeks(days: PlanDay[]): Week[] {
  const weeks: Week[] = []
  for (const day of days) {
    const start = weekStart(day.date)
    const last = weeks[weeks.length - 1]
    if (last && last.start === start) last.days.push(day)
    else weeks.push({ start, days: [day] })
  }
  return weeks
}

const toContext = (unitTitles: Record<string, string>, dailyMinutes: number): DescribeContext => ({ unitTitles, dailyMinutes })

function ItemRow({ item, today }: { item: DescribedPlanItem; today: boolean }) {
  const meta = [item.partLabel, item.done ? null : item.etaLabel.replace('About ', '')].filter(Boolean).join(', ')
  const showButton = today && !item.done
  return (
    <li className="relative flex min-h-11 items-start gap-3 py-2">
      <span className="mt-0.5 inline-flex shrink-0" role="img" aria-label={item.done ? 'Done' : 'To do'}>
        {item.done ? (
          <span className="grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
            <Check weight="bold" className="size-3" aria-hidden="true" />
          </span>
        ) : (
          <Circle className="size-5 text-fg-3" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {/* The whole row opens it (the link stretches over the row), so every row can be opened, not only today's. */}
        <Link
          href={item.href}
          className={cn(
            'inline-flex min-h-6 items-center rounded-chip text-body-strong after:absolute after:inset-0 hover:underline max-sm:min-h-7',
            item.done ? 'text-fg-3' : 'text-fg'
          )}
        >
          {item.title}
        </Link>
        {!item.done ? <p className="text-small text-fg-2">{item.reason}</p> : null}
        {meta ? <p className="text-caption font-normal text-fg-3">{meta}</p> : null}
        {item.overBudgetLabel && !item.done ? (
          <Badge tone="warning" className="mt-1">
            {item.overBudgetLabel}
          </Badge>
        ) : null}
      </div>
      {showButton ? (
        <Button asChild size="sm" variant="secondary" className="relative z-10 shrink-0">
          <Link href={item.href} aria-label={`${item.verb}: ${item.title}`}>
            {item.verb}
          </Link>
        </Button>
      ) : (
        <CaretRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-fg-3" />
      )}
    </li>
  )
}

function DayBadges({ day, collapsed = false }: { day: PlanDay; collapsed?: boolean }) {
  return (
    <>
      {day.isToday ? <Badge tone="accent">Today</Badge> : null}
      {day.isExamDay ? <Badge tone="warning">Exam day</Badge> : null}
      {day.isFinalReview && !day.isExamDay ? <Badge tone="neutral">Final review</Badge> : null}
      {/* A closed day line hides its rows, so the longer-than-usual mock shows on the line itself. */}
      {collapsed && day.items.some((item) => item.overBudget && !item.done) ? <Badge tone="warning">Longer than usual</Badge> : null}
    </>
  )
}

function dayMinutesLine(day: PlanDay): string | null {
  if (day.minutes + day.doneMinutes === 0) return null
  return day.isToday && day.doneMinutes > 0 ? `${day.doneMinutes} min done, ${day.minutes} to go` : `About ${day.minutes + day.doneMinutes} min`
}

function ItemList({ items, today }: { items: DescribedPlanItem[]; today: boolean }) {
  return (
    <ul className="min-w-0 divide-y divide-border">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} today={today} />
      ))}
    </ul>
  )
}

/** A day with its items showing: today, and the next two days. */
function DayCard({ day, items }: { day: PlanDay; items: DescribedPlanItem[] }) {
  const headingId = `day-${day.date}`
  const minutes = dayMinutesLine(day)
  return (
    <li
      aria-labelledby={headingId}
      aria-current={day.isToday ? 'date' : undefined}
      className={cn(
        'rounded-card border bg-surface p-4 sm:grid sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-x-5',
        day.isToday ? 'border-accent ring-1 ring-accent/30' : 'border-border'
      )}
    >
      <div className="mb-2 sm:mb-0">
        <h3 id={headingId} className="text-body-strong text-fg">
          {dayLabel(day.date)}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <DayBadges day={day} />
        </div>
        {minutes ? <p className="mt-1 text-caption font-normal tabular text-fg-3">{minutes}</p> : null}
      </div>
      {items.length > 0 ? (
        <ItemList items={items} today={day.isToday} />
      ) : (
        <p className="py-2 text-small text-fg-3">Nothing planned. A good day to rest.</p>
      )}
    </li>
  )
}

/** A later day: one line (the date, what is on it, the time) that opens to its items. */
function DayLine({ day, items }: { day: PlanDay; items: DescribedPlanItem[] }) {
  const headingId = `day-${day.date}`
  if (items.length === 0) {
    return (
      <li aria-labelledby={headingId} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-card border border-border bg-surface px-4 py-2">
        <h3 id={headingId} className="w-[116px] shrink-0 text-body-strong text-fg-2">
          {dayLabel(day.date)}
        </h3>
        <span className="text-small text-fg-3">Nothing planned. A good day to rest.</span>
      </li>
    )
  }
  const minutes = day.minutes + day.doneMinutes
  return (
    <li aria-labelledby={headingId} className="rounded-card border border-border bg-surface">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 rounded-card px-4 py-2 hover:bg-surface-2 sm:flex-nowrap [&::-webkit-details-marker]:hidden">
          <h3 id={headingId} className="w-[116px] shrink-0 text-body-strong text-fg">
            {dayLabel(day.date)}
          </h3>
          <span className="flex shrink-0 items-center gap-1.5 sm:order-last">
            <DayBadges day={day} collapsed />
            <span className="tabular text-caption font-normal text-fg-3">{minutes} min</span>
            <CaretDown aria-hidden="true" className="size-4 text-fg-3 transition-transform duration-180 group-open:rotate-180" />
          </span>
          <span className="min-w-0 flex-1 truncate text-small text-fg-2 max-sm:order-last max-sm:basis-full">
            {daySummary(items.map((item) => item.title))}
          </span>
        </summary>
        <div className="border-t border-border px-4 py-1">
          <ItemList items={items} today={false} />
        </div>
      </details>
    </li>
  )
}

type WeekProps = { describe: (day: PlanDay) => DescribedPlanItem[]; open: ReadonlySet<string> }

function WeekDays({ week, describe, open }: WeekProps & { week: Week }) {
  // Today and the next two days show their items; every other day is a line.
  return (
    <ol className="flex flex-col gap-3">
      {week.days.map((day) => {
        const items = describe(day)
        return open.has(day.date) ? <DayCard key={day.date} day={day} items={items} /> : <DayLine key={day.date} day={day} items={items} />
      })}
    </ol>
  )
}

function WeekSection({ week, current, describe, open }: WeekProps & { week: Week; current: boolean }) {
  const headingId = `week-${week.start}`
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 text-heading text-fg">
        {current ? 'This week' : weekLabel(week.start)}
        {current ? <span className="ml-2 text-small font-normal text-fg-3">{weekLabel(week.start)}</span> : null}
      </h2>
      {week.days.every((day) => day.items.length === 0 && !day.isToday) ? (
        <p className="rounded-card border border-border bg-surface p-4 text-small text-fg-3">
          Nothing planned this week. A good time to rest or catch up.
        </p>
      ) : (
        <WeekDays week={week} describe={describe} open={open} />
      )}
    </section>
  )
}

/** A week in the middle of a long plan: one line with what it holds, opening to its days. */
function FoldedWeek({ week, describe, open }: WeekProps & { week: Week }) {
  const items = week.days.flatMap((day) => day.items)
  const count = items.length
  const minutes = week.days.reduce((sum, day) => sum + day.minutes + day.doneMinutes, 0)
  return (
    <li>
      <details className="group rounded-card border border-border bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 rounded-card px-4 py-2 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          <h2 className="min-w-0 flex-1 text-body-strong text-fg">{weekLabel(week.start)}</h2>
          <span className="flex shrink-0 items-center gap-2 text-small text-fg-2">
            {count === 0 ? 'Nothing planned' : `${pluralize(count, 'item')}, about ${minutesLabel(minutes)}`}
            <CaretDown aria-hidden="true" className="size-4 text-fg-3 transition-transform duration-180 group-open:rotate-180" />
          </span>
        </summary>
        <div className="border-t border-border p-3">
          <WeekDays week={week} describe={describe} open={open} />
        </div>
      </details>
    </li>
  )
}

function summaryLine(plan: Plan): string {
  const minutes = `${minutesLabel(plan.dailyMinutes)} a day`
  if (plan.mode === 'exam' && plan.daysToExam !== null) {
    const when =
      plan.daysToExam === 0
        ? 'Your exam is today'
        : plan.daysToExam === 1
          ? 'Your exam is tomorrow'
          : `Your exam is in ${plan.daysToExam} days`
    return `${when}, ${dayLabel(plan.examDate as string, { long: true })}. Planned for ${minutes}.`
  }
  return `The next 14 days, planned for ${minutes}. Set your exam date to plan up to it.`
}

/** The study plan: a week by week list of what to do each day, today highlighted. */
export function PlanView({
  courseId,
  plan,
  unitTitles = {},
}: {
  courseId: string
  plan: Plan
  /** Unit names by id, so a learn row can say which unit it is in. */
  unitTitles?: Record<string, string>
}) {
  const base = `/courses/${courseId}`
  const context = toContext(unitTitles, plan.dailyMinutes)
  const describe = (day: PlanDay) => day.items.map((item) => describePlanItem(item, courseId, context))
  const settings = (
    <Button asChild variant="secondary" icon={<Gear />}>
      <Link href={`${base}/settings`}>Exam date and time</Link>
    </Button>
  )

  if (plan.status === 'no_topics') {
    return (
      <Page>
        <PageIntro title="Plan" description="What to study each day." />
        <EmptyState
          icon={<CalendarCheck />}
          title="Your plan starts with your topics"
          action={
            <Button asChild variant="primary">
              <Link href={`${base}/topics`}>Go to topics</Link>
            </Button>
          }
        >
          Add your materials and confirm the topics, then Margins plans your days.
        </EmptyState>
      </Page>
    )
  }

  if (plan.status === 'exam_passed') {
    return (
      <Page>
        <PageIntro title="Plan" description="What to study each day." actions={settings} />
        <InlineAlert
          tone="neutral"
          title="Your exam date has passed"
          action={
            <Button asChild size="sm" variant="primary">
              <Link href={`${base}/settings`}>Change the date</Link>
            </Button>
          }
        >
          Set a new date to plan your days again.
        </InlineAlert>
      </Page>
    )
  }

  const weeks = groupWeeks(plan.days)
  const thisWeek = weekStart(plan.today)
  const lastShown = plan.mode === 'exam' ? LAST_WEEKS_SHOWN : 0
  const firstCount = Math.min(FIRST_WEEKS_SHOWN, weeks.length)
  const head = weeks.slice(0, firstCount)
  const tailStart = Math.max(firstCount, weeks.length - lastShown)
  const middle = weeks.slice(firstCount, tailStart)
  const tail = weeks.slice(tailStart)
  const open = new Set(plan.days.slice(0, OPEN_DAYS).map((day) => day.date))
  const anyItems = plan.days.some((day) => day.items.length > 0)
  const notScheduled = plan.notScheduled
  const tooLong = plan.tooLongForDay
  const topicChips = (topics: { id: string; name: string }[]) => (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {topics.map((topic) => (
        <li key={topic.id}>
          <Link
            href={`${base}/topics/${topic.id}`}
            className="inline-flex min-h-7 items-center rounded-chip bg-surface-2 px-2 text-small text-fg-2 hover:text-fg max-sm:min-h-11"
          >
            {topic.name}
          </Link>
        </li>
      ))}
    </ul>
  )

  return (
    <Page>
      <PageIntro title="Plan" description={summaryLine(plan)} actions={settings} />

      <div className="flex flex-col gap-4">
        {plan.short && plan.shortMessage ? (
          <InlineAlert tone="warning" title="Time is short">
            {plan.shortMessage.replace(/^Time is short\.\s*/, '')}
          </InlineAlert>
        ) : null}
        {plan.unitMocksSkipped && !plan.short ? (
          <InlineAlert tone="neutral">
            The mock exams after each unit are left out so every topic fits before your exam.
          </InlineAlert>
        ) : null}
        {plan.mockNote && !(plan.short && plan.fullMocksReduced) ? <InlineAlert tone="neutral">{plan.mockNote}</InlineAlert> : null}
        {notScheduled ? (
          <section aria-labelledby="not-scheduled-heading" className="rounded-card border border-border bg-surface p-4">
            <h2 id="not-scheduled-heading" className="text-body-strong text-fg">
              Not scheduled: {pluralize(notScheduled.topics.length, 'topic')}
            </h2>
            <p className="mt-1 text-small text-fg-2">
              {notScheduled.reason === 'short'
                ? 'There is not enough time before your exam for these. Add study time or move the date to fit them in.'
                : 'These come after the days shown here.'}
            </p>
            {topicChips(notScheduled.topics)}
          </section>
        ) : null}
        {tooLong ? (
          <section aria-labelledby="too-long-heading" className="rounded-card border border-border bg-surface p-4">
            <h2 id="too-long-heading" className="text-body-strong text-fg">
              Longer than your daily time: {pluralize(tooLong.topics.length, 'topic')}
            </h2>
            <p className="mt-1 text-small text-fg-2">{tooLongText(plan.dailyMinutes)}</p>
            {topicChips(tooLong.topics)}
            {tooLong.dependents.length > 0 ? (
              <>
                <p className="mt-3 text-small text-fg-2">Waiting on them:</p>
                {topicChips(tooLong.dependents)}
              </>
            ) : null}
          </section>
        ) : null}
        {plan.reviewsNotScheduled ? (
          <InlineAlert tone="neutral">{reviewsNotScheduledText(plan.reviewsNotScheduled.map((topic) => topic.name))}</InlineAlert>
        ) : null}
      </div>

      {!anyItems ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="You're all caught up"
          action={
            <Button asChild variant="primary" icon={<ArrowRight />}>
              <Link href={`${base}/exams/new`}>New mock exam</Link>
            </Button>
          }
        >
          Nothing is due. A mock exam is a good way to find what to look at next.
        </EmptyState>
      ) : (
        <div className="mt-6 flex flex-col gap-10">
          {head.map((week) => (
            <WeekSection key={week.start} week={week} current={week.start === thisWeek} describe={describe} open={open} />
          ))}
          {middle.length > 0 ? (
            <section aria-labelledby="later-weeks-heading">
              <h2 id="later-weeks-heading" className="mb-3 text-heading text-fg">
                Later weeks <span className="text-small font-normal text-fg-3">({pluralize(middle.length, 'week')})</span>
              </h2>
              <ul className="flex flex-col gap-3">
                {middle.map((week) => (
                  <FoldedWeek key={week.start} week={week} describe={describe} open={open} />
                ))}
              </ul>
            </section>
          ) : null}
          {tail.map((week) => (
            <WeekSection key={week.start} week={week} current={false} describe={describe} open={open} />
          ))}
        </div>
      )}
    </Page>
  )
}
