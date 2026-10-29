'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InlineAlert } from '@/components/ui/inline-alert'
import { JobStatus } from '@/components/ui/job-status'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'
import { apiFetch, isApiError } from '@/lib/api/client'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { useJob } from '@/features/jobs/use-job'
import { aiMessage, isKnownAiCode, type AiMessage } from '@/lib/ai/messages'
import { fillResetTime } from '@/lib/budget/copy'
import type { ExamStyleState } from '@/lib/exams/style-state'
import { jobFailureMessage } from '@/lib/jobs/failure-message'
import { pollFailureMessage, type PollResult } from '@/lib/jobs/poll-job'
import { cn } from '@/lib/utils'
import {
  DEFAULT_EXAM_CONFIG,
  DIFFICULTIES,
  QUESTION_COUNTS,
  QUESTION_MIXES,
  TIME_LIMITS,
  difficultyLabel,
  type Difficulty,
  type QuestionMix,
} from './exam-options'

export type ExamTopicChoice = { id: string; name: string; mastery: number | null }

type Props = {
  courseId: string
  topics: ExamTopicChoice[]
  /** Topics to tick at first: due for review or not yet strong. */
  preselected: string[]
  /** An exam being written already, found on the server after a refresh. */
  activeJob: { id: string; startedAt: string } | null
  /** Whether the course's past exams have a style to match, and if not, why. */
  examStyle: ExamStyleState
}

/**
 * The form's states. A failure goes back to the form with every choice kept, says why, and offers
 * Try again when that may help; it never keeps the "writing" wait on screen.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'writing'; jobId: string; startedAt: string }
  | { kind: 'failed'; message: AiMessage }

const FAILED_TITLE = "Your exam couldn't be written"

/** What a finished poll that did not complete says. */
function failureFromPoll(result: PollResult): AiMessage {
  const job = result.job
  if (job?.status === 'failed') {
    const message = jobFailureMessage(job.errorCode, 'generate_exam')
    // On a failed job, `retryable` says whether starting again may help.
    return { ...message, retry: job.retryable ?? message.retry }
  }
  return { ...aiMessage(null), text: pollFailureMessage(result, 'The exam could not be written. Try again.') }
}

/** What a refused or failed start says. */
function failureFromRequest(caught: unknown): AiMessage {
  if (isApiError(caught) && isKnownAiCode(caught.code)) return aiMessage(caught.code)
  return { ...aiMessage(null), text: isApiError(caught) ? caught.message : 'Could not start your exam. Try again.' }
}

// Exams can take a couple of minutes to write.
const EXAM_JOB_TIMEOUT_MS = 300_000

function SectionLabel({ id, children, hint }: { id: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div>
      <h2 id={id} className="text-small font-medium text-fg">
        {children}
      </h2>
      {hint ? <p className="mt-0.5 text-caption font-normal text-fg-3">{hint}</p> : null}
    </div>
  )
}

/** The mock exam form, then the "Writing your exam" wait, then the lobby of the new exam. */
export function NewExamForm({ courseId, topics, preselected, activeJob, examStyle }: Props) {
  const router = useRouter()
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(preselected))
  const [totalQuestions, setTotalQuestions] = React.useState<number>(DEFAULT_EXAM_CONFIG.totalQuestions)
  const [durationMinutes, setDurationMinutes] = React.useState<number>(DEFAULT_EXAM_CONFIG.durationMinutes)
  const [difficulty, setDifficulty] = React.useState<Difficulty>(DEFAULT_EXAM_CONFIG.difficultyLevel)
  const [mix, setMix] = React.useState<QuestionMix>(DEFAULT_EXAM_CONFIG.mix)
  const [matchPastExams, setMatchPastExams] = React.useState(true)
  const [phase, setPhase] = React.useState<Phase>(() =>
    activeJob ? { kind: 'writing', jobId: activeJob.id, startedAt: activeJob.startedAt } : { kind: 'idle' }
  )
  const [submitting, setSubmitting] = React.useState(false)
  const { blocked, report } = useAiStatus()
  const failureRef = React.useRef<HTMLDivElement>(null)

  const fail = React.useCallback((message: AiMessage) => {
    setPhase({ kind: 'failed', message })
  }, [])

  // A failure shows at the top of the form: bring it into view.
  React.useEffect(() => {
    if (phase.kind === 'failed') failureRef.current?.scrollIntoView({ block: 'nearest' })
  }, [phase])

  const { job, timedOut } = useJob(phase.kind === 'writing' ? phase.jobId : null, {
    timeoutMs: EXAM_JOB_TIMEOUT_MS,
    onSettled: (result) => {
      if (result.state === 'completed') {
        const examId = result.job?.resultData?.exam_id
        router.push(typeof examId === 'string' ? `/courses/${courseId}/exams/${examId}` : `/courses/${courseId}/exams`)
      } else if (result.state === 'failed') {
        report(result.job?.errorCode)
        fail(failureFromPoll(result))
      }
    },
  })

  const matchStyle = examStyle.kind === 'ready' && matchPastExams

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })

  async function create() {
    setSubmitting(true)
    try {
      const result = await apiFetch<{ jobId: string }>(`/api/projects/${courseId}/generate-exam`, {
        method: 'POST',
        json: {
          topicIds: topics.filter((topic) => selected.has(topic.id)).map((topic) => topic.id),
          totalQuestions,
          durationMinutes,
          difficultyLevel: difficulty,
          questionTypeDistribution: QUESTION_MIXES[mix].distribution,
          ...(matchStyle ? { matchPastExams: true } : {}),
        },
      })
      setPhase({ kind: 'writing', jobId: result.jobId, startedAt: new Date().toISOString() })
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      fail(failureFromRequest(caught))
    } finally {
      setSubmitting(false)
    }
  }

  if (phase.kind === 'writing') {
    return (
      <div aria-live="polite">
        <div className="rounded-card border border-border bg-surface p-5">
          <JobStatus job={job} label="Writing your exam" since={phase.startedAt} timedOut={timedOut} />
          <p className="mt-3 text-small text-fg-2">
            This takes about a minute or two. You can leave this page and come back, your exam will be in the list.
          </p>
        </div>
        <div aria-hidden="true" className="mt-6 flex flex-col gap-4 rounded-card border border-border p-5">
          <Skeleton className="h-6 w-56 rounded-chip" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-24 rounded-chip" />
            <Skeleton className="h-5 w-20 rounded-chip" />
            <Skeleton className="h-5 w-16 rounded-chip" />
          </div>
          <SkeletonText lines={3} />
        </div>
        <div className="mt-6">
          <Button asChild variant="link">
            <Link href={`/courses/${courseId}/exams`}>Back to mock exams</Link>
          </Button>
        </div>
      </div>
    )
  }

  const allSelected = selected.size === topics.length
  const distribution = QUESTION_MIXES[mix].distribution
  const failure = phase.kind === 'failed' ? phase.message : null

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (selected.size > 0 && !submitting && !blocked) void create()
      }}
      className="flex flex-col gap-8"
    >
      {failure ? (
        <div ref={failureRef} className="scroll-mt-20">
          <InlineAlert
            tone={failure.tone === 'neutral' ? 'warning' : failure.tone}
            title={FAILED_TITLE}
            action={
              failure.retry && !blocked ? (
                <Button type="button" size="sm" variant="secondary" loading={submitting} onClick={() => void create()}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {fillResetTime(failure.text)}
          </InlineAlert>
        </div>
      ) : null}

      <section aria-labelledby="exam-topics" className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <SectionLabel id="exam-topics" hint="Topics that are due or still being learned are ticked for you.">
            Topics
          </SectionLabel>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={allSelected} onClick={() => setSelected(new Set(topics.map((t) => t.id)))}>
              Select all
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {topics.map((topic) => {
            const checked = selected.has(topic.id)
            return (
              <li key={topic.id}>
                <label
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-body text-fg',
                    'transition-colors duration-120 hover:bg-surface-2',
                    checked ? 'border-accent bg-accent-soft hover:bg-accent-soft' : 'border-control bg-surface'
                  )}
                >
                  <Checkbox checked={checked} onCheckedChange={(value) => toggle(topic.id, value === true)} className="mt-0" />
                  <span className="min-w-0 flex-1 truncate">{topic.name}</span>
                  <MasteryIndicator mastery={topic.mastery} variant="ring" />
                </label>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="exam-questions" className="flex flex-col gap-2">
        <SectionLabel id="exam-questions">Questions</SectionLabel>
        <SegmentedControl
          aria-labelledby="exam-questions"
          value={String(totalQuestions)}
          onValueChange={(value) => setTotalQuestions(Number(value))}
          options={QUESTION_COUNTS.map((count) => ({ value: String(count), label: String(count) }))}
          className="self-start"
        />
      </section>

      <section aria-labelledby="exam-time" className="flex flex-col gap-2">
        <SectionLabel id="exam-time">Time limit</SectionLabel>
        <SegmentedControl
          aria-labelledby="exam-time"
          value={String(durationMinutes)}
          onValueChange={(value) => setDurationMinutes(Number(value))}
          options={TIME_LIMITS.map((minutes) => ({ value: String(minutes), label: `${minutes} min` }))}
          className="self-start"
        />
      </section>

      <section aria-labelledby="exam-difficulty" className="flex flex-col gap-2">
        <SectionLabel id="exam-difficulty">Difficulty</SectionLabel>
        <SegmentedControl
          aria-labelledby="exam-difficulty"
          value={difficulty}
          onValueChange={setDifficulty}
          options={DIFFICULTIES.map((level) => ({ value: level, label: difficultyLabel(level) }))}
          className="self-start"
        />
      </section>

      <section aria-labelledby="exam-mix" className="flex flex-col gap-2">
        <SectionLabel
          id="exam-mix"
          hint={`${distribution.multiple_choice}% multiple choice, ${distribution.short_answer}% short answer, ${distribution.numerical}% numerical.`}
        >
          Question mix
        </SectionLabel>
        <SegmentedControl
          aria-labelledby="exam-mix"
          value={mix}
          onValueChange={setMix}
          options={(Object.keys(QUESTION_MIXES) as QuestionMix[]).map((key) => ({ value: key, label: QUESTION_MIXES[key].label }))}
          className="self-start"
        />
      </section>

      {examStyle.kind === 'ready' ? (
        <section aria-labelledby="exam-style" className="flex flex-col gap-2">
          <SectionLabel id="exam-style">Style</SectionLabel>
          <label
            className={cn(
              'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 text-body text-fg',
              'transition-colors duration-120 hover:bg-surface-2',
              matchPastExams ? 'border-accent bg-accent-soft hover:bg-accent-soft' : 'border-control bg-surface'
            )}
          >
            <Checkbox
              checked={matchPastExams}
              onCheckedChange={(value) => setMatchPastExams(value === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block">Match my past exams</span>
              <span className="mt-0.5 block text-caption font-normal text-fg-3">
                Questions follow the wording, task verbs and answer length of the exams you uploaded. The question mix above stays as chosen.
              </span>
            </span>
          </label>
        </section>
      ) : examStyle.kind !== 'none' ? (
        <ExamStyleStatus courseId={courseId} state={examStyle} />
      ) : null}

      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={selected.size === 0 || !!blocked}>
            Create exam
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link href={`/courses/${courseId}/exams`}>Cancel</Link>
          </Button>
          {selected.size === 0 ? <span className="text-small text-fg-2">Pick at least one topic.</span> : null}
        </div>
        <AiBlockedNote />
      </div>
    </form>
  )
}

const STYLE_COPY: Record<Exclude<ExamStyleState['kind'], 'ready' | 'none'>, { title: string; text: string }> = {
  analysing: {
    title: 'Your past exams are being analysed',
    text: 'Matching their style will be an option here once that is done, usually within a minute.',
  },
  failed: { title: "We couldn't analyse your past exams", text: '' },
  unavailable: {
    title: 'No exam style found',
    text: "We couldn't find a style to match in the past exams you uploaded. Questions will use the default style.",
  },
}

/** The Style section when there is no style to match yet: why, and a way to analyse again. */
function ExamStyleStatus({ courseId, state }: { courseId: string; state: ExamStyleState }) {
  const router = useRouter()
  const { blocked, report } = useAiStatus()
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const kind = state.kind as keyof typeof STYLE_COPY
  const copy = STYLE_COPY[kind]

  // While analysing, look again every few seconds (for about three minutes).
  React.useEffect(() => {
    if (kind !== 'analysing') return
    let count = 0
    const timer = setInterval(() => {
      count += 1
      if (count > 18) clearInterval(timer)
      else router.refresh()
    }, 10_000)
    return () => clearInterval(timer)
  }, [kind, router])

  async function retry() {
    setStarting(true)
    setStartError(null)
    try {
      await apiFetch(`/api/projects/${courseId}/exam-style`, { method: 'POST' })
      router.refresh()
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      setStartError(failureFromRequest(caught).text)
    } finally {
      setStarting(false)
    }
  }

  const text =
    kind === 'failed' ? jobFailureMessage(state.errorCode, 'profile_exam').text : copy.text
  return (
    <section aria-labelledby="exam-style" className="flex flex-col gap-2">
      <SectionLabel id="exam-style">Style</SectionLabel>
      <InlineAlert
        tone={kind === 'failed' ? 'warning' : 'neutral'}
        title={copy.title}
        action={
          kind === 'analysing' ? undefined : (
            <Button type="button" size="sm" variant="secondary" loading={starting} disabled={!!blocked} onClick={() => void retry()}>
              Analyse again
            </Button>
          )
        }
      >
        {fillResetTime(startError ?? text)}
      </InlineAlert>
    </section>
  )
}
