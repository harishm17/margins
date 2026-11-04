'use client'

import { useParams } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { NotFoundPanel } from '@/components/shell/not-found-panel'

/** Something inside a course that does not exist (a topic, an exam, a result): the course is fine, so lead back to it. */
export default function CourseNotFound() {
  const { courseId } = useParams<{ courseId: string }>()
  return (
    <Page width="focus">
      <NotFoundPanel
        className="py-24"
        body="The topic or exam may have been deleted, or the address is not quite right."
        action={{ href: `/courses/${courseId}`, label: 'Back to the course' }}
        secondary={{ href: '/home', label: 'Go to your courses' }}
      />
    </Page>
  )
}
