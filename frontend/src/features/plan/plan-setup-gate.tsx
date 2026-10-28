import Link from 'next/link'
import { CalendarCheck } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { CourseSetup } from '@/lib/course-setup'

/**
 * The Plan page before the topic list is confirmed (setup steps 1 and 2): the plan is built from the
 * confirmed list, so until then it points to the step that gets there.
 */
export function PlanSetupGate({ courseId, setup }: { courseId: string; setup: Extract<CourseSetup, { mode: 'setup' }> }) {
  const base = `/courses/${courseId}`
  const needsFiles = setup.step === 1
  return (
    <Page>
      <PageIntro title="Plan" description="What to study each day." />
      <EmptyState
        icon={<CalendarCheck />}
        title="Your plan starts with your topics"
        action={
          <Button asChild variant="primary">
            <Link href={needsFiles ? `${base}/materials` : `${base}/topics?edit=1`}>
              {needsFiles ? 'Add materials' : setup.label}
            </Link>
          </Button>
        }
      >
        {needsFiles
          ? 'Add your materials and confirm the topics, then Margins plans your days.'
          : 'Confirm the topics, then Margins plans your days.'}
      </EmptyState>
    </Page>
  )
}
