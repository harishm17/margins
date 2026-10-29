import type { Metadata } from 'next'
import { Page } from '@/components/shell/page'
import { NewCourseForm } from '@/features/courses/new-course-form'

export const metadata: Metadata = { title: 'New course' }

export default async function NewCoursePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams
  const first = welcome === '1'
  return (
    <Page width="narrow">
      <h1 className="text-title text-fg">{first ? "Let's set up your first course" : 'New course'}</h1>
      {first ? (
        <p className="mt-1.5 text-body text-fg-2">
          A course holds your files, topics and study content. Name it, then add your lecture notes.
        </p>
      ) : null}
      <div className="mt-8">
        <NewCourseForm />
      </div>
    </Page>
  )
}
