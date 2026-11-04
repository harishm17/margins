import Link from 'next/link'
import { Exam } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { ExamListItem } from '@/server/queries/mock-exams'
import { examSummary, formatScore } from './exam-options'

/** Mock exams as hairline rows: name and facts on the left, best score and the next step on the right. */
export function ExamList({ courseId, exams }: { courseId: string; exams: ExamListItem[] }) {
  return (
    <ul className="border-t border-border">
      {exams.map((exam) => {
        const href = `/courses/${courseId}/exams/${exam.id}`
        const action = exam.inProgress ? 'Resume' : exam.attemptCount > 0 ? 'View' : 'Open'
        return (
          <li key={exam.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-4">
            <div className="min-w-0 flex-1 basis-64">
              <h2 className="text-subheading text-fg">
                <Link href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-chip">
                  {exam.title}
                </Link>
              </h2>
              <p className="mt-0.5 text-small text-fg-2">
                {examSummary({
                  questionCount: exam.questionCount,
                  durationMinutes: exam.durationMinutes,
                  difficulty: exam.difficulty,
                })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {exam.inProgress ? (
                <Badge tone="warning">In progress</Badge>
              ) : exam.bestScore !== null ? (
                <span className="text-small text-fg-2">
                  Best score <span className="tabular text-body-strong text-fg">{formatScore(exam.bestScore)}</span>
                </span>
              ) : exam.attemptCount > 0 ? (
                <span className="text-small text-fg-3">Grading</span>
              ) : (
                <span className="text-small text-fg-3">Not taken yet</span>
              )}
              {/* What the button does follows where the exam stands; the page's one filled button is "New mock exam". */}
              <Button asChild size="sm" variant="secondary" className="relative z-10">
                <Link href={href} aria-label={`${action} ${exam.title}`}>
                  {action}
                </Link>
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function NoExams({ courseId, canCreate }: { courseId: string; canCreate: boolean }) {
  return (
    <EmptyState
      icon={<Exam />}
      title="No mock exams yet"
      action={
        canCreate ? (
          <Button asChild variant="primary">
            <Link href={`/courses/${courseId}/exams/new`}>New mock exam</Link>
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link href={`/courses/${courseId}/topics`}>Go to topics</Link>
          </Button>
        )
      }
    >
      {canCreate
        ? 'Pick topics, set a time limit, and take an exam under real conditions.'
        : 'Mock exams are built from your topics. Check and confirm your topics first, then come back.'}
    </EmptyState>
  )
}
