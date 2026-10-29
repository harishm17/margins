import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { CourseSettingsForm } from '@/features/courses/settings-form'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Course settings' }

export default async function CourseSettingsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()

  return (
    <Page width="narrow">
      <h1 className="text-title text-fg">Course settings</h1>
      <p className="mt-1.5 text-body text-fg-2">Rename the course, set your exam date and how long you can study each day.</p>
      <div className="mt-8">
        <CourseSettingsForm
          course={{
            id: course.id,
            name: course.name,
            description: course.description,
            examDate: course.examDate,
            dailyMinutes: course.dailyMinutes,
          }}
        />
      </div>
    </Page>
  )
}
