import * as React from 'react'
import Link from 'next/link'
import { CaretDown, Check } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { newTopicsLabel } from '@/lib/course-setup'
import { pluralize } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SetupData } from '@/server/queries/course'
import { COURSE_STAGES, COURSE_STAGES_SUMMARY, TOPIC_STEPS_TEXT } from './course-stages'
import { MaterialsManager } from './materials-manager'
import { CheckTopicsStep, StartStudyingStep } from './setup-steps'

type StepState = 'done' | 'current' | 'upcoming'

function Step({
  number,
  state,
  title,
  last,
  children,
}: {
  number: number
  state: StepState
  title: string
  last?: boolean
  children?: React.ReactNode
}) {
  return (
    <li aria-current={state === 'current' ? 'step' : undefined} className="flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full text-small font-medium tabular',
            state === 'done' && 'bg-accent text-accent-fg',
            state === 'current' && 'border-2 border-accent bg-surface text-accent-soft-fg',
            state === 'upcoming' && 'border border-border-strong bg-surface text-fg-3'
          )}
        >
          {state === 'done' ? (
            <>
              <Check aria-hidden="true" weight="bold" className="size-3.5" />
              <span className="sr-only">Done: step {number}</span>
            </>
          ) : (
            <span aria-hidden="true">{number}</span>
          )}
        </span>
        {last ? null : <span aria-hidden="true" className={cn('mt-1 w-px flex-1', state === 'done' ? 'bg-accent/40' : 'bg-border')} />}
      </div>
      <div className={cn('min-w-0 flex-1', last ? 'pb-0' : state === 'current' ? 'pb-8' : 'pb-5')}>
        <h2 className={cn('pt-0.5 text-subheading', state === 'upcoming' ? 'text-fg-2' : 'text-fg')}>{title}</h2>
        {children}
      </div>
    </li>
  )
}

const description = 'mt-1 text-small text-fg-2'

/** A closed disclosure under a step: the detail is there when wanted, and the step stays one line. */
function Disclosure({ summary, open, children, className }: { summary: React.ReactNode; open?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <details open={open} className={cn('group mt-2', className)}>
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1.5 rounded-chip text-small text-accent hover:underline max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        {summary}
        <CaretDown aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-180" />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

/** What the page says under the course name, by where the course is: the status first, not the whole list of steps. */
function introLine(setup: SetupData): string {
  const { step, materials, plan } = setup
  if (step === 1) return materials.materials.length === 0 ? "You haven't added any files yet." : 'Margins is reading your files. Three steps and you’re ready to study.'
  if (step === 2) return 'Your files are ready.'
  return plan.askForExamDate ? 'Your topics are confirmed. Add your exam date if you know it, then start your first topic.' : 'Your course is ready. Start with your first topic.'
}

/**
 * The setup page until the course has confirmed topics and some study content. A finished stage shrinks to one line
 * (its summary and the link that reopens it), and the stage the student is on has the room: the files while none are
 * read, the topics once they are found, the exam date and the first topic at the end.
 */
export function SetupGuide({ courseId, name, setup }: { courseId: string; name: string; setup: SetupData }) {
  const { step, materials } = setup
  const filesProcessing = materials.processingCount > 0
  // On a phone a link in a finished step is a 44px row, not a line of text.
  const link = 'rounded-chip text-accent hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center'
  // Topics are found and every file is read: the upload stage has done its job, so it folds to a line with "Add more files".
  const filesDone = step === 2 && setup.topics.total > 0 && !filesProcessing

  return (
    <Page width="focus">
      <PageIntro title={name} description={introLine(setup)} />
      {/* Topics found after the list was confirmed wait for review here too, with the same words as on the overview. */}
      {step === 3 && newTopicsLabel(setup.topics) ? (
        <InlineAlert
          tone="accent"
          className="mb-6 max-w-[720px]"
          title={newTopicsLabel(setup.topics)}
          action={
            <Button asChild size="sm" variant="primary">
              <Link href={`/courses/${courseId}/topics?edit=1`}>Review new topics</Link>
            </Button>
          }
        >
          They join your plan once you confirm them.
        </InlineAlert>
      ) : null}
      <ol className="max-w-[720px]" aria-label="Setup steps">
        <Step number={1} state={step > 1 ? 'done' : 'current'} title={COURSE_STAGES[0].title}>
          {step <= 2 ? (
            // Stays mounted through step 2: when the last file is read, this step keeps its place and only the
            // next step changes, so nothing jumps under the student's thumb. Once topics are found it folds.
            <>
              {filesDone ? (
                <p className={description}>{pluralize(materials.readyCount, 'file')} ready.</p>
              ) : (
                <p className={description}>
                  Upload lecture notes, past exams or book chapters. Margins reads them to find your topics.
                </p>
              )}
              {filesDone ? (
                <Disclosure summary="Add more files">
                  <MaterialsManager
                    variant="inline"
                    courseId={courseId}
                    maxUploadMb={materials.maxUploadMb}
                    materials={materials.materials}
                    typicalReadSeconds={materials.typicalReadSeconds}
                  />
                </Disclosure>
              ) : (
                <MaterialsManager
                  variant="inline"
                  courseId={courseId}
                  maxUploadMb={materials.maxUploadMb}
                  materials={materials.materials}
                  typicalReadSeconds={materials.typicalReadSeconds}
                />
              )}
            </>
          ) : (
            <p className={description}>
              {pluralize(materials.readyCount, 'file')} ready.{' '}
              <Link href={`/courses/${courseId}/materials`} className={link}>
                Add more in Materials
              </Link>
            </p>
          )}
        </Step>

        <Step number={2} state={step > 2 ? 'done' : step === 2 ? 'current' : 'upcoming'} title={COURSE_STAGES[1].title}>
          {step === 2 ? (
            <CheckTopicsStep
              courseId={courseId}
              extractJob={materials.extractJob}
              extractFailure={materials.extractFailure}
              topics={setup.topics}
              topicPreview={setup.topicPreview}
              label={setup.label}
              filesProcessing={filesProcessing}
              filesRead={materials.readyCount}
              filesTotal={materials.materials.length}
            />
          ) : step > 2 ? (
            <p className={description}>
              {pluralize(setup.topics.confirmed, 'topic')} confirmed.{' '}
              <Link href={`/courses/${courseId}/topics?edit=1`} className={link}>
                Edit topics
              </Link>
            </p>
          ) : filesProcessing && materials.materials.length > 0 ? (
            <p className={description}>{`Waiting for your files: ${materials.readyCount} of ${materials.materials.length} read.`}</p>
          ) : null}
        </Step>

        <Step number={3} state={step === 3 ? 'current' : 'upcoming'} title={COURSE_STAGES[2].title} last>
          {step === 3 ? (
            <StartStudyingStep courseId={courseId} firstTopic={setup.firstTopic} generation={setup.generation} plan={setup.plan} />
          ) : null}
        </Step>
      </ol>

      {/* The longer text of the stages is help, not the page: it opens from here. Home's "How a course goes" says the same three. */}
      <Disclosure summary={step === 1 ? 'What the next steps involve' : 'What each step involves'} className="mt-6 max-w-[720px]">
        <p className="text-small text-fg-2">{COURSE_STAGES_SUMMARY}</p>
        <ol className="mt-3 flex flex-col gap-3 text-small text-fg-2">
          {COURSE_STAGES.map((stage, index) => (
            <li key={stage.title}>
              <span className="font-medium text-fg">
                {index + 1}. {stage.title}.
              </span>{' '}
              {stage.text}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-small text-fg-2">{TOPIC_STEPS_TEXT}</p>
      </Disclosure>
    </Page>
  )
}
