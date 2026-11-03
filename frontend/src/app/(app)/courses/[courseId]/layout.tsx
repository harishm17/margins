import { notFound } from 'next/navigation'
import { ExamInProgressCue } from '@/features/exams/exam-in-progress-cue'
import { getCourseShell } from '@/server/queries/courses'
import { getOpenExamId } from '@/server/queries/exams'
import { requireUser } from '@/server/session'

/** Every course page: the course must be the signed-in user's, otherwise it is a 404. */
export default async function CourseLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ courseId: string }>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const [course, openExamId] = await Promise.all([getCourseShell(user.id, courseId), getOpenExamId(user.id, courseId)])
  if (!course) notFound()
  return (
    <>
      {openExamId ? <ExamInProgressCue courseId={courseId} examId={openExamId} /> : null}
      {children}
    </>
  )
}
