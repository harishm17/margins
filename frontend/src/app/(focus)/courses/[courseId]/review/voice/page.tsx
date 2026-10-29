import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Microphone } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { VoiceFocus } from '@/features/voice/voice-focus'
import { getCourseShell } from '@/server/queries/courses'
import { describeSprintTopics, getSprintTopics } from '@/server/queries/voice'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Voice practice' }

/**
 * Voice practice on a screen of its own: the focus layout (no sidebar, an Exit back to Review), so a
 * live session never runs under the Review lists and the page does not jump while the student speaks.
 */
export default async function VoicePracticePage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()
  const sprint = await getSprintTopics(user.id, courseId)

  if (sprint.topics.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 md:px-6">
        <EmptyState
          icon={<Microphone />}
          title="Nothing to practise yet"
          action={
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/topics`}>Go to topics</Link>
            </Button>
          }
        >
          Confirm your topics and open one to write its notes. Voice practice then asks you about the weakest ones.
        </EmptyState>
      </div>
    )
  }

  return <VoiceFocus courseId={courseId} courseName={course.name} description={describeSprintTopics(sprint.topics, sprint.studied)} />
}
