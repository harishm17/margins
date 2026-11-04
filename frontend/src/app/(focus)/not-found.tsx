'use client'

import { useParams } from 'next/navigation'
import { NotFoundPanel } from '@/components/shell/not-found-panel'

/** Inside the exam focus shell, which already has its own bar: no brand, no second header. */
export default function FocusNotFound() {
  const { courseId } = useParams<{ courseId?: string }>()
  return (
    <div className="px-4 pt-16">
      <NotFoundPanel
        body="The exam may have been deleted, or the address is not quite right."
        action={courseId ? { href: `/courses/${courseId}/exams`, label: 'Back to mock exams' } : { href: '/home', label: 'Go to your courses' }}
        secondary={courseId ? { href: '/home', label: 'Go to your courses' } : undefined}
      />
    </div>
  )
}
