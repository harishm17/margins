'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BookOpen, CaretDown, Check, Lightning, Microphone, Sparkle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { ProgressRing, scoreRingSize } from '@/components/ui/progress-ring'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { toast } from '@/components/ui/toaster'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import { apiFetch } from '@/lib/api/client'
import { CONFIDENCE_LEVELS, CONFIDENCE_WORDS, QUIZ_RATING, type ConfidenceId } from '@/lib/learning/calibration'
import { formatScore } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { groupResults, SURE_CONFIDENCE, type QuizReviewItem } from '@/lib/learning/quiz-review'
import { studyOutcome, nextReviewLabel } from '@/lib/learning/consequence'
import { browserTimeZone } from '@/lib/utils/timezone'
import { buildEntries, ReviewList } from './quiz-review-list'
import { partialLine, type PartialQuiz } from '@/lib/learning/quiz-partial'

export type QuizResult = {
  score: number
  earnedPoints: number
  totalPoints: number
  bestScore: number
  review: QuizReviewItem[]
  answers: Record<string, string>
  /** How sure the student was, by question index, for the questions where they said (spec §5.7). */
  confidence?: Record<string, number>
  /** How many they expected to get right, when they said in the lobby. */
  predicted?: number
  /** What the attempt changed: when the topic is next reviewed, and how its mastery moved. */
  outcome?: { nextReviewAt: string | null; mastery: number | null; previousMastery: number | null }
  /** Where to look for the missed questions (spec 18.5), and which concepts each missed question tests. */
  helpAfterMiss?: HelpAfterMiss
  missedConcepts?: Record<string, string[]>
}

/** Copy drafts for Harish to review (spec 18.6, 18.10). */
export const SOLID_FOR_NOW_TEXT = 'Solid for now. It counts as solid once it holds up on another day.'

/**
 * "Where to look: p. 12" for one missed question: the page of the first claim of each concept it tests, as links that
 * open the reader there. A concept with no page is named instead. Null when the question has no pointer.
 */
export function pointerLine(pointers: HelpAfterMiss['pointers']): { conceptId: string; text: string; href: string }[] {
  const several = pointers.length > 1
  return pointers.map((pointer) => ({
    conceptId: pointer.conceptId,
    href: pointer.href,
    text: pointer.page ? (several ? `p. ${pointer.page} (${pointer.conceptName})` : `p. ${pointer.page}`) : pointer.conceptName,
  }))
}

const points = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What the student expected beside what they got, in words that work without a colour. */
function predictionLine(predicted: number, actual: number) {
  const expected = `You expected to get ${plural(predicted, 'question')} right and got ${actual}.`
  if (actual === predicted) return `${expected} Your estimate was spot on.`
  return `${expected} ${actual > predicted ? 'You knew more than you thought.' : 'It was harder than it felt.'}`
}

function ConfidencePrompt({ topicId, onSaved }: { topicId: string; onSaved: (nextReviewAt: string | null) => void }) {
  const router = useRouter()
  const [chosen, setChosen] = React.useState<ConfidenceId | ''>('')
  const [saving, setSaving] = React.useState(false)
  const [next, setNext] = React.useState<string | null>(null)

  async function choose(level: ConfidenceId) {
    if (saving || chosen !== '') return
    setSaving(true)
    try {
      const saved = await apiFetch<{ nextReviewAt: string | null }>(`/api/topics/${topicId}/confidence`, {
        method: 'POST',
        json: { source: 'quiz', value: QUIZ_RATING[level] },
      })
      setChosen(level)
      // The rating moves the review date: the line above and the topic header say the new one.
      onSaved(saved?.nextReviewAt ?? null)
      React.startTransition(() => router.refresh())
      const next = nextReviewLabel(saved?.nextReviewAt, new Date(), browserTimeZone())
      setNext(next)
      toast.success(next ? `Saved. ${next}.` : 'Saved. Your review date is updated.')
    } catch {
      toast.error("Couldn't save that. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-8 border-t border-border pt-4">
      <p id="confidence-label" className="text-small font-medium text-fg">
        How sure were you overall?
      </p>
      <SegmentedControl
        aria-labelledby="confidence-label"
        className="mt-2"
        value={chosen}
        disabled={saving || chosen !== ''}
        onValueChange={(level) => level && choose(level)}
        options={CONFIDENCE_LEVELS.map((level) => ({
          value: level.id,
          label: (
            <span className="inline-flex items-center gap-1">
              {chosen === level.id ? <Check weight="bold" className="size-3.5" aria-hidden /> : null}
              {CONFIDENCE_WORDS[level.id]}
            </span>
          ),
        }))}
      />
      <p className="mt-2 text-caption font-normal text-fg-3" aria-live="polite">
        {next ? `${next}.` : 'Guessing or Unsure brings the next review back tomorrow.'}
      </p>
    </div>
  )
}

/** The score, a filter, every question reviewed, and a confidence rating. */
export function QuizResults({
  courseId,
  topicId,
  questions,
  result,
  voiceHref,
  onNewQuestions,
  onHarderSet,
  onClose,
}: {
  courseId: string
  topicId: string
  questions: PublicQuizQuestion[]
  result: QuizResult
  voiceHref: string
  onNewQuestions: () => void
  /** "Harder set": a new set of hard questions (offered when every answer was right and sure). */
  onHarderSet?: () => void
  onClose: () => void
}) {
  const [filter, setFilter] = React.useState<'all' | 'missed'>('all')
  // The question-by-question review is a section the student opens on a phone, so the score, what to do next and the way
  // out are on the first screen; a wide screen has the room and shows it. (Results are drawn after an answer is graded, in the
  // browser, so the screen's width is known here.)
  const [reviewOpen, setReviewOpen] = React.useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 639px)').matches)
  const reviewId = React.useId()
  // Focus moves to the results when they arrive, so a screen reader starts at the score and not at the page's top.
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])
  const entries = React.useMemo(
    () => buildEntries(questions, result.review, result.answers),
    [questions, result.review, result.answers]
  )
  const missed = entries.filter((entry) => !entry.review.isCorrect)
  // The order of spec §5.7: sure and wrong, other wrong, right but unsure, solid.
  const sections = React.useMemo(() => {
    const confidence = Object.fromEntries(Object.entries(result.confidence ?? {}).map(([key, value]) => [key, { confidence: value }]))
    const groups = groupResults(entries.map((entry) => entry.review), confidence)
    const byIndex = new Map(entries.map((entry) => [entry.index, entry]))
    const pick = (items: QuizReviewItem[]) => items.flatMap((item) => byIndex.get(item.questionIndex) ?? [])
    return [
      { key: 'sure-wrong', title: 'You were sure about these', note: 'You felt sure and it was wrong. A miss like this is the one you remember best, so read the answer closely.', entries: pick(groups.sureWrong), missed: true },
      { key: 'wrong', title: groups.sureWrong.length > 0 ? 'Other wrong answers' : 'Wrong answers', note: null, entries: pick(groups.wrong), missed: true },
      { key: 'unsure-right', title: "Right, but you weren't sure", note: 'Worth one more look so the answer holds next time.', entries: pick(groups.unsureRight), missed: false },
      { key: 'solid', title: 'Solid answers', note: null, entries: pick(groups.solid), missed: false },
    ].filter((section) => section.entries.length > 0 && (filter === 'all' || section.missed))
  }, [entries, result.confidence, filter])
  const correctCount = entries.filter((entry) => entry.review.isCorrect).length
  // Every answer right and sure: "Solid for now" and a harder set. The label does not change; solid still needs another day (spec 18.6).
  const allRightAndSure =
    entries.length > 0 && entries.every((entry) => entry.review.isCorrect && (result.confidence?.[String(entry.index)] ?? 0) >= SURE_CONFIDENCE)
  const help = result.helpAfterMiss
  const pointersFor = (index: number) => {
    const ids = result.missedConcepts?.[String(index)]
    return ids && help ? pointerLine(help.pointers.filter((pointer) => ids.includes(pointer.conceptId))) : []
  }
  // After a miss the one primary step is going back to what was missed: its first idea, in the student's own pages (or its explanation).
  // New questions and voice practice are the quieter choices beside it. A quiz with nothing missed has no repair to lead with.
  const repair =
    missed.length > 0 && !(allRightAndSure && onHarderSet)
      ? help?.pointers[0]
        ? { href: help.pointers[0].href, label: 'Review the first missed idea' }
        : help?.explainer
          ? { href: help.explainer.href, label: 'Review the first missed idea' }
          : null
      : null
  const score = formatScore(result.score)
  // What this quiz changed, in the student's own days (the browser's zone).
  // The review date is the topic's, and a confidence rating below moves it: both lines read the same value.
  const [nextReviewAt, setNextReviewAt] = React.useState<string | null | undefined>(undefined)
  const outcome = result.outcome
    ? { ...result.outcome, nextReviewAt: nextReviewAt === undefined ? result.outcome.nextReviewAt : nextReviewAt }
    : null
  const outcomeText = outcome ? studyOutcome(outcome, new Date(), browserTimeZone()) : null

  return (
    <div className="max-w-[720px]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <ProgressRing size={scoreRingSize(result.score)} value={result.score / 100} label={score} aria-label={`Score ${score}`} />
        <div className="min-w-40 flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="text-heading text-fg outline-none">
            <span className="tabular">
              {points(result.earnedPoints)} of {points(result.totalPoints)} points
            </span>
          </h2>
          <p className="mt-0.5 text-small text-fg-2" data-testid="quiz-counts">
            <span className="tabular">{correctCount}</span> of <span className="tabular">{entries.length}</span> {entries.length === 1 ? 'question' : 'questions'} right.
          </p>
          {result.bestScore > result.score ? (
            <p className="mt-0.5 text-small text-fg-2">
              Your best is <span className="tabular">{formatScore(result.bestScore)}</span>.
            </p>
          ) : null}
          {result.predicted !== undefined ? (
            <p className="mt-0.5 text-small text-fg-2">{predictionLine(result.predicted, correctCount)}</p>
          ) : null}
          {outcomeText ? <p className="mt-0.5 text-small text-fg-2">{outcomeText}</p> : null}
          {allRightAndSure ? (
            <p className="mt-0.5 text-small text-fg-2" data-testid="solid-for-now">
              {SOLID_FOR_NOW_TEXT}
            </p>
          ) : null}
          <div aria-live="polite">
            <ExpectedMiss surface="quiz_results" summaryMissedShare={1 - result.score / 100} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {allRightAndSure && onHarderSet ? (
            <Button variant="primary" icon={<Lightning />} onClick={onHarderSet}>
              Harder set
            </Button>
          ) : null}
          {repair ? (
            <Button asChild variant="primary" icon={<BookOpen />}>
              <Link href={repair.href} scroll={false} data-testid="review-first-missed">
                {repair.label}
              </Link>
            </Button>
          ) : null}
          {/* One next step leads (the primary button above); with none, new questions do. The others are the quiet choices beside it. */}
          <Button variant={repair || (allRightAndSure && onHarderSet) ? 'ghost' : 'primary'} icon={<Sparkle />} onClick={onNewQuestions}>
            New questions
          </Button>
          <Button asChild variant="ghost" icon={<Microphone />}>
            <Link href={voiceHref} scroll={false}>
              Voice practice
            </Link>
          </Button>
        </div>
      </div>

      <div className="mt-6 sm:mt-8">
        <Button
          variant="ghost"
          className="-ml-3.5 sm:hidden"
          aria-expanded={reviewOpen}
          aria-controls={reviewId}
          onClick={() => setReviewOpen((current) => !current)}
        >
          <span className="inline-flex items-center gap-1.5">
            {reviewOpen ? 'Hide the question review' : `Review the questions${missed.length > 0 ? ` (${missed.length} missed)` : ''}`}
            <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', reviewOpen && 'rotate-180')} />
          </span>
        </Button>
      </div>

      <div id={reviewId} className={cn('sm:mt-2', !reviewOpen && 'max-sm:hidden')}>
      <div className="max-sm:mt-2">
        <SegmentedControl
          aria-label="Filter questions"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: 'all', label: `All ${entries.length}` },
            { value: 'missed', label: `Missed ${missed.length}` },
          ]}
        />
      </div>

      <div className="mt-2">
        {sections.length > 0 ? (
          sections.map((section) => (
            <section key={section.key} aria-labelledby={`results-${section.key}`} className="mt-6 first:mt-2">
              <h3 id={`results-${section.key}`} className="text-body-strong text-fg">
                {section.title} <span className="tabular text-fg-3">({section.entries.length})</span>
              </h3>
              {section.note ? <p className="mt-0.5 text-small text-fg-2">{section.note}</p> : null}
              {section.missed ? (
                section.entries.map((entry) => {
                  const lines = pointersFor(entry.index)
                  return (
                    <div key={entry.index}>
                      <ReviewList entries={[entry]} courseId={courseId} topicId={topicId} />
                      {lines.length > 0 ? (
                        <p className="-mt-2 pb-4 text-small text-fg-2" data-testid="where-to-look">
                          Where to look:{' '}
                          {lines.map((line, position) => (
                            <React.Fragment key={line.conceptId}>
                              {position > 0 ? ', ' : null}
                              <Link href={line.href} className="text-fg underline underline-offset-2" scroll={false}>
                                {line.text}
                              </Link>
                            </React.Fragment>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  )
                })
              ) : (
                <ReviewList entries={section.entries} courseId={courseId} topicId={topicId} />
              )}
            </section>
          ))
        ) : (
          <p className="py-8 text-small text-fg-2">You got every question right. Nothing to review here.</p>
        )}
      </div>
      </div>

      {help && (help.explainer || help.easierStep) ? (
        <div className="mt-6 flex flex-wrap items-center gap-2" data-testid="quiz-help">
          {help.explainer ? (
            <Button asChild variant="secondary" icon={<BookOpen />}>
              <Link href={help.explainer.href} scroll={false}>
                Read the explanation of what you missed
              </Link>
            </Button>
          ) : null}
          {help.easierStep ? (
            <Button asChild variant="secondary">
              <Link href={help.easierStep.href} scroll={false}>
                {help.easierStep.label}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfidencePrompt topicId={topicId} onSaved={setNextReviewAt} />

      <div className="mt-8 border-t border-border pt-5">
        <Button variant="ghost" className="-ml-3.5" onClick={onClose}>
          Back to quiz
        </Button>
      </div>
    </div>
  )
}

/**
 * The multiple choice, true or false and numerical answers of a quiz whose short answers wait for the AI (spec 18.9):
 * what is graded, question by question, and a line that says what waits. There is no overall score until everything is graded.
 */
export function PartialResults({
  courseId,
  topicId,
  questions,
  partial,
}: {
  courseId: string
  topicId: string
  questions: PublicQuizQuestion[]
  partial: PartialQuiz
}) {
  const entries = React.useMemo(() => buildEntries(questions, partial.review, partial.answers), [questions, partial.review, partial.answers])
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <section aria-labelledby="partial-results" className="max-w-[720px]" data-testid="partial-results">
      <h2 id="partial-results" ref={headingRef} tabIndex={-1} className="text-heading text-fg outline-none">
        Graded so far
      </h2>
      <p className="mt-1.5 text-small text-fg-2">{partialLine(partial.summary)}</p>
      <div className="mt-4">
        <ReviewList entries={entries} courseId={courseId} topicId={topicId} />
      </div>
    </section>
  )
}
