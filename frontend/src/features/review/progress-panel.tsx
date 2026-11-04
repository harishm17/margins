import Link from 'next/link'
import { CaretRight } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { CALIBRATION_DAYS, MIN_WEEK_EVENTS, type Progress } from '@/server/queries/progress'
import { pluralize } from '@/lib/format'
import { CONFIDENCE_LEVELS } from '@/lib/learning/calibration'
import { reviewSessionHref } from '@/lib/learning/review-links'
import {
  calibrationSentence,
  CONFIDENCE_NAMES,
  focusReason,
  isEarlyWeeks,
  percent,
  sparklinePath,
  sparklinePoints,
  weekLabel,
  weeklyDescription,
} from './progress-copy'

/**
 * What the student can see about their own ability (spec §10): average score on their own first tries by
 * week, calibration once there is enough of it, how often help was used, and the few ideas worth this week's
 * time. No streaks, points, badges or completion bars. Every figure is also written out in text.
 */

/**
 * "This week's focus": up to three ideas, each with why and a button into a drill on it. It sits above the
 * session card, so its buttons are outlined and "Start today's review" stays the one filled button. The cards
 * are compact on a phone (button beside the text) to keep that button near the top.
 */
export function WeeklyFocus({ courseId, focus, optional = false }: { courseId: string; focus: Progress['focus']; optional?: boolean }) {
  if (focus.length === 0) return null
  return (
    <section aria-labelledby="focus-heading">
      <h2 id="focus-heading" className="text-heading text-fg">
        {optional ? 'Optional focus' : "This week's focus"}
      </h2>
      <p className="mt-1 text-small text-fg-2">
        {optional
          ? 'Nothing is due, so these are extra: the few ideas most worth your time if you want to keep going.'
          : 'The few ideas most worth your time, so you do not have to pick from everything.'}
      </p>
      <ol className="mt-3 flex flex-col gap-2 sm:gap-3">
        {focus.map((item) => (
          <li key={item.conceptId} className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2.5 sm:p-4">
            <div className="min-w-0">
              <h3 className="text-body-strong text-fg">
                {item.name}
                <span className="text-caption font-normal text-fg-3"> · {item.topicName}</span>
              </h3>
              <p className="mt-0.5 text-small text-fg-2">{focusReason(item)}</p>
            </div>
            <Button asChild variant="secondary" size="sm" className="shrink-0">
              <Link href={reviewSessionHref(courseId, { conceptId: item.conceptId })} aria-label={`Practice this: ${item.name}`}>
                Practice this
              </Link>
            </Button>
          </li>
        ))}
      </ol>
    </section>
  )
}

const CHART = { width: 320, height: 72, pad: 6 }

/** Average score by week as a line with a dot per week; the table under it carries the same numbers. */
function WeeklyScore({ weekly }: { weekly: Progress['weekly'] }) {
  const points = sparklinePoints(weekly, CHART.width, CHART.height, CHART.pad)
  const path = sparklinePath(weekly, points)
  const last = weekly[weekly.length - 1]
  return (
    <div>
      <h3 className="text-body-strong text-fg">Average score by week</h3>
      <p className="mt-0.5 text-small text-fg-2">Your average score on first tries, week by week.</p>
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={weeklyDescription(weekly)}
        className="mt-3 h-auto w-full max-w-[320px] text-accent"
      >
        {/* The top and bottom of the scale, 100% and 0%; the caption under the chart says so in words. */}
        <line x1="0" x2={CHART.width} y1={CHART.pad} y2={CHART.pad} className="stroke-border" strokeDasharray="2 3" />
        <line x1="0" x2={CHART.width} y1={CHART.height - CHART.pad} y2={CHART.height - CHART.pad} className="stroke-border" strokeDasharray="2 3" />
        {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null}
        {points.map((point, index) => (
          <circle key={weekly[index].week} cx={point.x} cy={point.y} r={index === points.length - 1 ? 4 : 3} fill="currentColor" />
        ))}
      </svg>
      <table className="mt-3 w-full max-w-[320px] text-small">
        <caption className="sr-only">Average score on first tries by week, with the number of tries behind each</caption>
        <thead>
          <tr className="text-left text-caption text-fg-3">
            <th scope="col" className="py-1 pr-3 font-medium">
              Week of
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Tries
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Average score
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-y border-border">
          {[...weekly].reverse().map((row) => (
            <tr key={row.week} className={row === last ? 'text-fg' : 'text-fg-2'}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                {weekLabel(row.week)}
              </th>
              <td className="tabular py-1.5 pr-3 text-right">{row.n}</td>
              <td className="tabular py-1.5 text-right">{percent(row.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The four confidence levels against the average score at each. A bar and its number say the same thing. */
function Calibration({ calibration }: { calibration: Progress['calibration'] }) {
  const sentence = calibrationSentence(calibration.bins)
  return (
    <div>
      <h3 className="text-body-strong text-fg">How sure you were, and what you scored</h3>
      <p className="mt-0.5 text-small text-fg-2">{sentence ?? 'Your score at each level of confidence you chose.'}</p>
      <table className="mt-3 w-full text-small">
        <caption className="sr-only">
          Average score at each level of confidence, from {calibration.n} answers given without help in the last {CALIBRATION_DAYS} days
        </caption>
        <thead>
          <tr className="text-left text-caption text-fg-3">
            <th scope="col" className="py-1 pr-3 font-medium">
              You said
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Answers
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Average score
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-y border-border">
          {CONFIDENCE_LEVELS.map((level) => {
            const bin = calibration.bins.find((candidate) => candidate.label === level.id)
            const n = bin?.n ?? 0
            return (
              <tr key={level.id} className="text-fg-2">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg">
                  {CONFIDENCE_NAMES[level.id]}
                </th>
                <td className="tabular py-1.5 pr-3 text-right">{n}</td>
                <td className="py-1.5">
                  {n > 0 && bin ? (
                    <span className="flex items-center justify-end gap-2">
                      <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-full border border-control bg-surface-3">
                        <span className="block h-full rounded-full bg-accent" style={{ width: percent(bin.accuracy) }} />
                      </span>
                      <span className="tabular w-10 text-right text-fg">{percent(bin.accuracy)}</span>
                    </span>
                  ) : (
                    <span className="block text-right text-fg-3">
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">no answers</span>
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The Progress section at the foot of the Review page. Nothing is shown for a figure that has nothing behind it yet. */
export function ProgressPanel({ progress }: { progress: Progress }) {
  const { weekly, calibration, assistedShare, weekAnswers } = progress
  return (
    <section aria-labelledby="progress-heading">
      <h2 id="progress-heading" className="text-heading text-fg">
        Progress
      </h2>
      <p className="mt-1 text-small text-fg-2">Only what you answered yourself counts here.</p>
      {isEarlyWeeks(progress) ? (
        <div aria-live="polite" className="mt-1">
          <ExpectedMiss surface="progress_early" />
        </div>
      ) : null}
      <div className="mt-3 grid gap-6 rounded-card border border-border bg-surface p-4 md:grid-cols-2 md:p-5">
        <div className="flex flex-col gap-6">
          {weekly.length > 0 ? (
            <WeeklyScore weekly={weekly} />
          ) : (
            <div>
              <h3 className="text-body-strong text-fg">Average score by week</h3>
              <p className="mt-0.5 text-small text-fg-2">This appears once a week has {MIN_WEEK_EVENTS} first tries without help.</p>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="text-body-strong text-fg">Help this week</h3>
            <p className="mt-0.5 text-small text-fg-2">
              {weekAnswers === 0
                ? 'No answers yet this week.'
                : assistedShare === 0
                  ? `No help used on ${pluralize(weekAnswers, 'answer')} this week.`
                  : `Help used on ${percent(assistedShare)} of answers this week.`}
            </p>
          </div>
          {calibration.ready ? <Calibration calibration={calibration} /> : null}
        </div>
      </div>
      {/* The rules behind the figures, for the student who wants them: the page itself stays a name and a sentence per figure. */}
      <details className="group mt-3 text-small text-fg-2">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip hover:text-fg max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
          <CaretRight aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-90" />
          How this is calculated
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          <li>
            Average score: your own first tries, without hints or worked examples. A miss that then needed a hint or the answer counts as 0.
            Weeks with fewer than {MIN_WEEK_EVENTS} such tries are left out.
          </li>
          <li>Chart: the top line is 100% and the bottom line is 0%. A gap is a week with too few tries.</li>
          <li>Help: a hint, a tutor turn, a revealed answer or a worked example all count as help.</li>
          <li>
            Confidence: answers without help in the last {CALIBRATION_DAYS} days that had a confidence tap. Answers where you chose not to rate
            are not counted.
          </li>
        </ul>
      </details>
    </section>
  )
}
