'use client'

import * as React from 'react'
import { CaretDown, Lightning, Plus, Sparkle } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { InlineAlert } from '@/components/ui/inline-alert'
import { formatDate, formatDateTime, formatScore, pluralize } from '@/lib/format'
import { RETRY_WAIT_TEXT } from '@/lib/learning/missed'
import { localDateParts } from '@/lib/learning/study-plan-time'
import { browserTimeZone } from '@/lib/utils/timezone'
import type { QuizAttemptData, QuizSetData, TopicReview } from '@/server/queries/topic'
import { cn } from '@/lib/utils'
import { GenerateOptions } from './generation-ui'
import { ReviewActions } from './review-actions'
import { ReviewList, buildEntries } from './quiz-review-list'
import { ViewSkeleton } from './skeletons'
import { useGeneration } from './topic-provider'
import { useHydrated } from './use-hydrated'

const TYPE_LABELS: Record<string, string> = {
  multiple_choice: 'multiple choice',
  short_answer: 'short answer',
  numerical: 'numerical',
  true_false: 'true or false',
}

/** "multiple choice, short answer, numerical", in the order the types first appear. */
export function questionMix(set: QuizSetData): string {
  const seen = new Set<string>()
  for (const question of set.questions) seen.add(question.question_type)
  return [...seen].map((type) => TYPE_LABELS[type] ?? type).join(', ')
}

/** The prediction select's "no prediction" value (an option value cannot be empty). */
const SKIP = 'skip'

const scoreTone = (score: number) => (score >= 70 ? 'accent' : 'neutral')

function Attempt({
  attempt,
  set,
  showSet,
  courseId,
  topicId,
}: {
  attempt: QuizAttemptData
  set: QuizSetData | undefined
  showSet: boolean
  courseId: string
  topicId: string
}) {
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()
  const entries = React.useMemo(
    () => (set && attempt.review ? buildEntries(set.questions, attempt.review, attempt.answers) : []),
    [set, attempt.review, attempt.answers]
  )

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <time dateTime={attempt.takenAt} suppressHydrationWarning className="tabular min-w-0 flex-1 text-small text-fg">
          {formatDateTime(attempt.takenAt)}
          {showSet ? <span className="ml-2 text-fg-3">{set?.label ?? 'Earlier set'}</span> : null}
        </time>
        <Badge tone={scoreTone(attempt.score)} className="tabular">
          {formatScore(attempt.score)}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="inline-flex items-center gap-1">
            Review
            <CaretDown className={cn('size-3.5 transition-transform duration-180', open && 'rotate-180')} />
          </span>
        </Button>
      </div>
      {open ? (
        <div id={panelId} className="mt-2 rounded-card border border-border px-4">
          {entries.length > 0 ? (
            <ReviewList entries={entries} courseId={courseId} topicId={topicId} />
          ) : (
            <p className="py-4 text-small text-fg-2">The review isn&apos;t available for this attempt any more.</p>
          )}
        </div>
      ) : null}
    </li>
  )
}

type QuizLobbyProps = {
  courseId: string
  topicId: string
  review: TopicReview
  sets: QuizSetData[]
  attempts: QuizAttemptData[]
  setId: string
  onSetChange: (id: string) => void
  /** `predicted` is how many questions the student expects to get right, when they said. */
  onStart: (predicted?: number) => void
  /** A new set is being written: the lobby body gives way to a skeleton. */
  generating: boolean
  /** A harder quiz was asked for (the transfer-quiz activity); `fresh` says the open set is a new all-hard one. */
  harder?: { fresh: boolean }
  /** A saved quiz on this set: "Resume (6 of 10 answered)". */
  resume?: { answered: number } | null
  onResume?: () => void
  /** The server refused to start this set again: it was taken today (RETRY_TOMORROW). */
  refused?: boolean
  /** "New questions": a fresh set at the topic's band. */
  onNewQuestions?: () => void
  /** The quiz was just left with "Save and finish later". */
  savedNote?: boolean
}

const dayOf = (instant: Date, timeZone: string) => {
  const { year, month, day } = localDateParts(instant, timeZone)
  return `${year}-${month}-${day}`
}

/** Pick a set, see how you did, start, or create a new set. */
export function QuizLobby({ courseId, topicId, review, sets, attempts, setId, onSetChange, onStart, generating, harder, resume, onResume, refused, onNewQuestions, savedNote }: QuizLobbyProps) {
  const hydrated = useHydrated()
  const { generate, starting } = useGeneration('quiz')
  const set = sets.find((item) => item.id === setId) ?? sets[0]
  const setAttempts = attempts.filter((attempt) => attempt.setId === set.id)
  const best = setAttempts.length > 0 ? Math.max(...setAttempts.map((attempt) => attempt.score)) : null
  const multipleSets = sets.length > 1
  // The same questions open from the next local day (spec 7.3): today a set that was taken offers new questions instead.
  const hydratedToday = hydrated ? dayOf(new Date(), browserTimeZone()) : null
  const takenToday = refused === true || (hydratedToday !== null && setAttempts.some((attempt) => dayOf(new Date(attempt.takenAt), browserTimeZone()) === hydratedToday))
  const [predicted, setPredicted] = React.useState(SKIP)
  const predictedId = React.useId()
  const retryNoteId = React.useId()
  const showNewSet = !(takenToday && onNewQuestions)
  // A prediction was for the set it was made on.
  const predictedHere = predicted === SKIP || Number(predicted) <= set.questions.length ? predicted : SKIP

  return (
    <div className="max-w-[720px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading text-fg">Quiz</h2>
        {/* One way to a new set at a time: once this set has been taken today, "New questions" below is it. */}
        {showNewSet ? (
          <GenerateOptions kind="quiz" mode="regenerate" submitLabel="Create quiz set" align="end">
            <Button size="sm" variant="ghost" icon={<Plus />} disabled={generating}>
              New quiz set
            </Button>
          </GenerateOptions>
        ) : null}
      </div>

      {harder && !generating ? (
        <section aria-labelledby="harder-heading" className="mt-5 rounded-card border border-border bg-surface-2 p-4">
          <h3 id="harder-heading" className="flex items-center gap-2 text-body-strong text-fg">
            <Lightning aria-hidden="true" className="size-4 text-accent" />A harder quiz
          </h3>
          {harder.fresh ? (
            <p className="mt-1 text-small text-fg-2">
              Every question in this set is hard, and you have not taken it yet. It checks that what you know holds up on new questions.
            </p>
          ) : (
            <>
              <p className="mt-1 text-small text-fg-2">
                You know this topic well. A set of hard questions you have not seen checks that it holds up on new questions.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="primary"
                icon={<Lightning />}
                loading={starting}
                onClick={() => void generate('regenerate', { question_count: 10, difficulty_level: 'hard' })}
              >
                Create a harder set
              </Button>
            </>
          )}
        </section>
      ) : null}

      {review.due && !generating ? (
        <section aria-labelledby="due-review-heading" className="mt-5 rounded-card border border-border bg-surface-2 p-4">
          <h3 id="due-review-heading" className="text-body-strong text-fg">
            Due for review
          </h3>
          <p className="mt-1 text-small text-fg-2">
            {review.missedCount > 0
              ? `You missed ${review.missedCount === 1 ? 'a question' : `${review.missedCount} questions`} lately. ${
                  review.retryOpensAt ? 'Fix it now with new questions' : `Go over ${review.missedCount === 1 ? 'it' : 'them'} again, or take a fresh set`
                }.`
              : 'Take a fresh set of questions to keep this topic strong.'}
          </p>
          <div className="mt-3">
            <ReviewActions courseId={courseId} topicId={topicId} missedCount={review.missedCount} retryOpensAt={review.retryOpensAt} />
          </div>
        </section>
      ) : null}

      {generating ? (
        <div className="mt-6">
          <ViewSkeleton kind="quiz" />
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
              {multipleSets ? (
                <Select
                  aria-label="Quiz set"
                  value={set.id}
                  onValueChange={onSetChange}
                  className="w-56"
                  options={sets.map((item) => ({
                    value: item.id,
                    label: hydrated ? `${item.label}, ${formatDate(item.createdAt)}` : item.label,
                    hint: pluralize(item.questions.length, 'question'),
                  }))}
                />
              ) : (
                <p className="text-subheading text-fg">{set.label}</p>
              )}
              <span className="whitespace-nowrap text-small text-fg-2">
                {pluralize(set.questions.length, 'question')}
              </span>
            </div>
            <p className="tabular text-small text-fg-2">
              {best !== null ? `Best ${Math.round(best)}%, ` : ''}
              {setAttempts.length === 0 ? 'No attempts yet' : pluralize(setAttempts.length, 'attempt')}
            </p>
          </div>

          <p className="mt-4 text-small text-fg-2">Mix: {questionMix(set)}</p>
          <p className="mt-1 text-small text-fg-2">
            Answers are checked when you submit. Short answers are graded with feedback.
          </p>

          <div className="mt-5">
            <label htmlFor={predictedId} className="text-small text-fg-2">
              Guess your score to compare it with your result (optional)
            </label>
            <Select
              id={predictedId}
              value={predictedHere}
              onValueChange={setPredicted}
              className="mt-1.5 w-56"
              placeholder="Skip this"
              options={[
                { value: SKIP, label: 'Skip this' },
                ...Array.from({ length: set.questions.length + 1 }, (_unused, count) => ({
                  value: String(count),
                  label: `${count} of ${set.questions.length}`,
                })),
              ]}
            />
          </div>

          {savedNote ? (
            <InlineAlert className="mt-5" tone="accent">
              Your answers are saved. Pick up where you left off from this quiz&apos;s page.
            </InlineAlert>
          ) : null}

          {resume && onResume ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button size="lg" variant="primary" onClick={onResume}>
                Resume ({resume.answered} of {set.questions.length} answered)
              </Button>
              {!takenToday ? (
                <Button size="lg" variant="ghost" onClick={() => onStart(predictedHere === SKIP ? undefined : Number(predictedHere))}>
                  Start over
                </Button>
              ) : null}
            </div>
          ) : takenToday ? (
            <div className="mt-6" data-testid="retry-tomorrow">
              <p id={retryNoteId} className="text-small text-fg-2">
                {RETRY_WAIT_TEXT}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {/* The attempted set has a visible state of its own: it is not lost, it opens tomorrow. */}
                <Button size="lg" variant="secondary" disabled disabledReason="The same questions open tomorrow.">
                  Retake tomorrow
                </Button>
                {onNewQuestions ? (
                  <Button size="lg" variant="primary" icon={<Sparkle />} onClick={onNewQuestions}>
                    New questions
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <Button className="mt-6" size="lg" variant="primary" onClick={() => onStart(predictedHere === SKIP ? undefined : Number(predictedHere))}>
              Start quiz
            </Button>
          )}
        </>
      )}

      {attempts.length > 0 ? (
        <section aria-labelledby="past-attempts" className="mt-12">
          <h3 id="past-attempts" className="text-subheading text-fg">
            Past attempts
          </h3>
          <ul className="mt-2 divide-y divide-border">
            {attempts.slice(0, 10).map((attempt) => (
              <Attempt
                key={attempt.id}
                attempt={attempt}
                set={sets.find((item) => item.id === attempt.setId)}
                showSet={multipleSets}
                courseId={courseId}
                topicId={topicId}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
