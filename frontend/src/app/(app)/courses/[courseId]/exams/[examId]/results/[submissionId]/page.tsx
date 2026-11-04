import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Page, PageIntro } from '@/components/shell/page'
import { PageHeader } from '@/components/shell/slots'
import { examCrumbs } from '@/features/courses/exam-crumbs'
import { GradedResults, GradingFailed, GradingPanel } from '@/features/exams/exam-results'
import { splitExamTitle } from '@/lib/exams/display'
import { formatDateTime } from '@/lib/format'
import { getCourseShell } from '@/server/queries/courses'
import { getExamResult } from '@/server/queries/mock-exams'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Mock exam results' }

export default async function ExamResultsPage({
  params,
}: {
  params: Promise<{ courseId: string; examId: string; submissionId: string }>
}) {
  const user = await requireUser()
  const { courseId, examId, submissionId } = await params
  const [course, result] = await Promise.all([
    getCourseShell(user.id, courseId),
    getExamResult(user.id, courseId, examId, submissionId),
  ])
  if (!course || !result) notFound()

  // The same short name as the lobby ("Mock exam · Nov 4"), so the breadcrumb reads alike on both pages.
  const examName = splitExamTitle(result.examTitle).name
  return (
    <Page width="focus">
      <PageHeader crumbs={examCrumbs({ id: course.id, name: course.name }, { id: result.examId, name: examName }, 'Results')} />
      {result.status === 'graded' ? (
        <>
          <h1 className="sr-only">Results for {examName}</h1>
          <GradedResults result={result} submittedLabel={formatDateTime(result.submittedAt)} />
        </>
      ) : (
        <>
          <PageIntro title="Your results" description={`${examName}, submitted ${formatDateTime(result.submittedAt)}`} />
          {result.status === 'grading' ? <GradingPanel result={result} /> : <GradingFailed result={result} />}
        </>
      )}
    </Page>
  )
}
