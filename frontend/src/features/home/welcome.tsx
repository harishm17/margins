import Link from 'next/link'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'

/** The stages of a course, with rough times. A signed-in student never sees the landing page, so this is where it is explained. */
const COURSE_STAGES = [
  {
    title: 'Add your files',
    time: 'A couple of minutes',
    text: 'Lecture notes or slides, book chapters and past exams. Margins reads them to find your topics.',
  },
  {
    title: 'Check the topics Margins finds',
    time: 'About a minute',
    text: 'Rename, merge or remove any topic, then confirm the list.',
  },
  {
    title: 'Set your exam date and daily time',
    time: 'Under a minute',
    text: 'You get a day-by-day plan that ends at your exam.',
  },
  {
    title: 'Study a little each day',
    time: 'Your daily time',
    text: 'Every topic has five steps: Warm-up (try a few questions first), Read (your own pages), Recall (with the book closed), Practice and a Quiz. Reviews and mock exams come before the exam.',
  },
] as const

const HAVE_READY = [
  'Lecture notes or slides',
  'Book chapters',
  'Past exams, if you have them (you mark them as past exams so Margins can match their style)',
  'The date of your exam',
] as const

/** Home for an account with no courses: what Margins does, how a course goes, what to have ready, and one action. */
export function Welcome() {
  return (
    <Page width="medium">
      <PageIntro
        title="Welcome to Margins"
        description="Margins builds a study plan from your own course files and your exam date. You try each topic before you read it, so what you read sticks."
      />
      <div className="flex flex-col gap-10">
        <section aria-labelledby="stages-heading">
          <h2 id="stages-heading" className="text-heading text-fg">
            How a course goes
          </h2>
          <ol className="mt-4 flex flex-col gap-5">
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

        <section aria-labelledby="ready-heading">
          <h2 id="ready-heading" className="text-heading text-fg">
            Have these ready
          </h2>
          <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-small text-fg-2 marker:text-fg-3">
            {HAVE_READY.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <div>
          <Button asChild variant="primary" size="lg">
            <Link href="/courses/new">Add your first course</Link>
          </Button>
        </div>
      </div>
    </Page>
  )
}
