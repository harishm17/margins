import Link from 'next/link'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { COURSE_STAGES, COURSE_STAGES_SUMMARY } from '@/features/course/course-stages'

/** Home for an account with no courses: what Margins does, how a course goes, what to have ready, and one action. */
export function Welcome() {
  return (
    <Page width="focus">
      <PageIntro
        title="Welcome to Margins"
        description="Margins builds a study plan from your own course files and your exam date. You try each topic before you read it, so what you read sticks."
        actions={
          <Button asChild variant="primary">
            <Link href="/courses/new">Add your first course</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-10">
        <section aria-labelledby="stages-heading">
          <h2 id="stages-heading" className="text-heading text-fg">
            Set up your first course
          </h2>
          <p className="mt-1 text-small text-fg-2">{COURSE_STAGES_SUMMARY}</p>
          <ol className="mt-5 flex flex-col gap-5">
            {COURSE_STAGES.map((stage, index) => (
              <li key={stage.title} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full border border-border-strong bg-surface text-small font-medium tabular text-fg-2"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="flex flex-wrap items-baseline gap-x-3 text-subheading text-fg">
                    {stage.title}
                    <span className="text-caption font-normal text-fg-3">{stage.time}</span>
                  </h3>
                  <p className="mt-1 text-small text-fg-2">{stage.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

      </div>
    </Page>
  )
}
