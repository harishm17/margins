import * as React from 'react'
import Link from 'next/link'
import { Check } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { pluralize } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SetupData } from '@/server/queries/course'
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
      <div className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-8')}>
        <h2 className={cn('pt-0.5 text-subheading', state === 'upcoming' ? 'text-fg-2' : 'text-fg')}>{title}</h2>
        {children}
      </div>
    </li>
  )
}

const description = 'mt-1 text-small text-fg-2'

/** The vertical stepper shown until the course has confirmed topics and some study content. */
export function SetupGuide({ courseId, name, setup }: { courseId: string; name: string; setup: SetupData }) {
  const { step, materials } = setup
  const filesProcessing = materials.processingCount > 0
  const link = 'rounded-chip text-accent hover:underline'

  return (
    <Page>
      <PageIntro title={name} description="Three steps and you're ready to study." />
      <ol className="max-w-[720px]" aria-label="Setup steps">
        <Step number={1} state={step > 1 ? 'done' : 'current'} title="Add your materials">
          {step <= 2 ? (
            // Stays through step 2: when the last file is read, this step keeps its size and only the
            // next step changes, so nothing jumps under the student's thumb.
            <>
              <p className={description}>
                Upload lecture notes, past exams or book chapters. Margins reads them to find your topics.
              </p>
              <MaterialsManager
                variant="inline"
                courseId={courseId}
                maxUploadMb={materials.maxUploadMb}
                materials={materials.materials}
                typicalReadSeconds={materials.typicalReadSeconds}
              />
            </>
          ) : (
            <p className={description}>
              {pluralize(materials.readyCount, 'file')} ready. Add more any time in{' '}
              <Link href={`/courses/${courseId}/materials`} className={link}>
                Materials
              </Link>
              .
            </p>
          )}
        </Step>

        <Step number={2} state={step > 2 ? 'done' : step === 2 ? 'current' : 'upcoming'} title="Check the topics">
          {step === 2 ? (
            <CheckTopicsStep
              courseId={courseId}
              extractJob={materials.extractJob}
              extractFailure={materials.extractFailure}
              topics={setup.topics}
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
          ) : (
            // The same height as the step when it is current, so it opens without moving what is below.
            <div className="min-h-[108px]">
              <p className={description}>
                {filesProcessing && materials.materials.length > 0
                  ? `Waiting for your files: ${materials.readyCount} of ${materials.materials.length} read.`
                  : 'Margins finds the topics in your files. Rename, merge or remove any, then confirm.'}
              </p>
            </div>
          )}
        </Step>

        <Step number={3} state={step === 3 ? 'current' : 'upcoming'} title="Start studying" last>
          <p className={description}>Notes, worked examples, practice and a quiz for each topic, written as you go.</p>
          {step === 3 ? (
            <StartStudyingStep courseId={courseId} firstTopic={setup.firstTopic} generation={setup.generation} />
          ) : null}
        </Step>
      </ol>
    </Page>
  )
}
