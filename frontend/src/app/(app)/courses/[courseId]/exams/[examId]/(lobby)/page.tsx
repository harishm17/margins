import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Page, PageIntro } from '@/components/shell/page'
import { PageHeader } from '@/components/shell/slots'
import { examCrumbs } from '@/features/courses/exam-crumbs'
import { ExamLobbyView } from '@/features/exams/exam-lobby'
import { getCourseShell } from '@/server/queries/courses'
import { getExamLobby } from '@/server/queries/mock-exams'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Mock exam' }

export default async function ExamLobbyPage({ params }: { params: Promise<{ courseId: string; examId: string }> }) {
  const user = await requireUser()
  const { courseId, examId } = await params
  const [course, lobby] = await Promise.all([getCourseShell(user.id, courseId), getExamLobby(user.id, courseId, examId)])
  if (!course || !lobby) notFound()

  return (
    <Page width="medium">
      <PageHeader crumbs={examCrumbs({ id: course.id, name: course.name }, { id: lobby.id, name: lobby.title })} />
      <PageIntro title={lobby.title} description="A timed mock exam built from your topics." />
      <ExamLobbyView lobby={lobby} />
    </Page>
  )
}
