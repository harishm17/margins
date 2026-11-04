import Link from 'next/link'
import { Check } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Spinner } from '@/components/ui/spinner'
import { formatDateTime } from '@/lib/format'
import type { AttemptRow, ExamLobby } from '@/server/queries/mock-exams'
import { GradeAgainButton, StartExamButton } from './exam-actions'
import { LobbyRefresh } from './lobby-refresh'
import { difficultyLabel, formatMinutes, formatScore } from './exam-options'

const BEFORE_YOU_START = [
  'The timer starts when you press start. It keeps running if you leave the page.',
  'Your answers save automatically as you go.',
  'You can submit early. Questions you leave blank score zero.',
  'Short answers are graded with feedback, which can take a minute.',
]

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="mt-0.5 tabular text-subheading text-fg">{children}</dd>
    </div>
  )
}

function AttemptItem({ attempt, courseId, examId }: { attempt: AttemptRow; courseId: string; examId: string }) {
  const resultsHref = `/courses/${courseId}/exams/${examId}/results/${attempt.id}`
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3.5">
      <p className="min-w-0 flex-1 basis-40 text-body text-fg">{formatDateTime(attempt.submittedAt)}</p>
      <div className="flex items-center gap-3">
        {attempt.state === 'graded' && attempt.score !== null ? (
          <Badge tone={attempt.score >= 70 ? 'accent' : 'neutral'} className="tabular">
            {formatScore(attempt.score)}
          </Badge>
        ) : attempt.state === 'grading' ? (
          <span className="flex items-center gap-1.5 text-small text-fg-2">
            <Spinner className="text-accent" />
            Grading
          </span>
        ) : (
          <Badge tone="danger">Grading failed</Badge>
        )}
        {attempt.state === 'failed' ? (
          <GradeAgainButton courseId={courseId} examId={examId} submissionId={attempt.id} />
        ) : (
          <Button asChild size="sm" variant="secondary">
            <Link href={resultsHref}>Results</Link>
          </Button>
        )}
      </div>
    </li>
  )
}

/** Facts, what to expect, the start button and the attempt history. */
export function ExamLobbyView({ lobby }: { lobby: ExamLobby }) {
  const { id, courseId } = lobby
  return (
    <div className="flex flex-col gap-10">
      <LobbyRefresh grading={lobby.attempts.some((attempt) => attempt.state === 'grading')} />
      <section aria-label="About this exam" className="flex flex-col gap-5">
        <dl className="grid grid-cols-3 gap-4 border-y border-border py-4 sm:max-w-md">
          <Fact label="Questions">{lobby.questionCount}</Fact>
          <Fact label="Time limit">{formatMinutes(lobby.durationMinutes)}</Fact>
          <Fact label="Difficulty">{difficultyLabel(lobby.difficulty)}</Fact>
        </dl>
        {lobby.topics.length > 0 ? (
          <div>
            <h2 className="text-small font-medium text-fg">Covers</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {lobby.topics.map((topic) => (
                <li key={topic}>
                  <Badge>{topic}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {lobby.leftOut.length > 0 ? (
        <InlineAlert tone="warning" title={`Left out of this exam: ${lobby.leftOut.join(', ')}`}>
          There are no pages to write questions from {lobby.leftOut.length === 1 ? 'for it' : 'for them'}. Add the material, then make a new exam to cover {lobby.leftOut.length === 1 ? 'it' : 'them'}.
        </InlineAlert>
      ) : null}

      <section aria-labelledby="before-you-start">
        <h2 id="before-you-start" className="text-heading text-fg">
          Before you start
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {BEFORE_YOU_START.map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-body text-fg-2">
              <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-accent" />
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-6">
          <StartExamButton courseId={courseId} examId={id} resumeSeconds={lobby.inProgress?.remainingSeconds ?? null} />
        </div>
      </section>

      <section aria-labelledby="attempts">
        <h2 id="attempts" className="text-heading text-fg">
          Your attempts
        </h2>
        {lobby.attempts.length > 0 ? (
          <ul className="mt-3 border-t border-border">
            {lobby.attempts.map((attempt) => (
              <AttemptItem key={attempt.id} attempt={attempt} courseId={courseId} examId={id} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-small text-fg-2">You haven&apos;t taken this exam yet.</p>
        )}
      </section>
    </div>
  )
}
