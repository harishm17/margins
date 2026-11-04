import type { Metadata } from 'next'
import Link from 'next/link'
import { BookOpenText, Plus } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ContinueCard } from '@/features/home/continue-card'
import { CourseGrid } from '@/features/home/course-grid'
import { DueReviews } from '@/features/home/due-reviews'
import { ShortSessionCard } from '@/features/home/short-session-card'
import { Greeting } from '@/features/home/greeting'
import { SHORT_SESSION_LOCKED_TEXT, hasFirstQuizOrRecall, shortSessionOffer } from '@/lib/learning/short-session-server'
import { continueAction } from '@/server/queries/continue'
import { listCourses } from '@/server/queries/courses'
import { dueReviews } from '@/server/queries/reviews'
import { requireUser } from '@/server/session'
import { HomeSkeleton } from '@/features/shell/page-skeletons'
import { getTimeZoneState } from '@/server/timezone'

export const metadata: Metadata = { title: 'Home' }

export default async function HomePage() {
  const user = await requireUser()
  const { timeZone, known } = await getTimeZoneState()
  if (!known) return <HomeSkeleton />
  const [courses, due, next] = await Promise.all([
    listCourses(user.id),
    dueReviews(user.id, timeZone, 5),
    continueAction(user.id, timeZone),
  ])

  // "Have 10 minutes?" for the course in "Up next" (spec 18.8). An extra: if it cannot be worked out Home still shows.
  // Not before the student has a first quiz or recall: there is nothing to go over yet, so Home says what opens it.
  const unlocked = next ? await hasFirstQuizOrRecall(user.id, next.course.id).catch(() => false) : false
  const short = next && unlocked ? await shortSessionOffer(user.id, next.course.id, timeZone).catch(() => null) : null

  if (courses.length === 0) {
    return (
      <Page>
        <h1 className="sr-only">Home</h1>
        <EmptyState
          className="py-24"
          icon={<BookOpenText />}
          title="Add your first course"
          action={
            <Button asChild variant="primary" size="lg">
              <Link href="/courses/new">Add a course</Link>
            </Button>
          }
        >
          Upload lecture notes, past exams or chapters. Margins turns them into notes, practice and quizzes.
        </EmptyState>
      </Page>
    )
  }

  return (
    <Page>
      <PageIntro
        title={<Greeting name={user.name} />}
        description="Here's where you left off."
        actions={
          <Button asChild variant="primary" icon={<Plus />}>
            <Link href="/courses/new">New course</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-10">
        {next ? <ContinueCard data={next} /> : null}
        {next && short ? <ShortSessionCard courseId={next.course.id} plan={short.plan} /> : null}
        {next && !unlocked ? (
          <p className="-mt-6 text-small text-fg-2" data-testid="short-session-locked">
            {SHORT_SESSION_LOCKED_TEXT}
          </p>
        ) : null}
        <DueReviews items={due.items} total={due.total} />
        <CourseGrid courses={courses} />
      </div>
    </Page>
  )
}
