'use client'

import Link from 'next/link'
import { SourceIcon, SourceLink } from '@/components/learning/source-link'
import { MathText } from '@/components/ui/math-text'
import type { TopicStructure } from '@/server/queries/topic'

const linkClass =
  'rounded-chip underline decoration-border-strong decoration-1 underline-offset-[3px] transition-colors duration-120 hover:text-fg hover:decoration-fg-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center'

/** "Week 3: Sorting", "Sorting" or "Week 3" for the unit a topic belongs to. */
export function unitLabel(unit: { title: string; weekLabel: string | null }): string {
  return unit.weekLabel ? `${unit.weekLabel}: ${unit.title}` : unit.title
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-x-3 gap-y-0.5 sm:flex-row">
      <dt className="shrink-0 text-small text-fg-3 sm:w-20">{label}</dt>
      <dd className="min-w-0 text-small text-fg-2">{children}</dd>
    </div>
  )
}

/**
 * What the topic covers and where it comes from, under the title: the objectives ("By the end you
 * can ..."), the topics it builds on, and the files it is taught from. Compact on purpose. On a
 * phone the header folds the whole block behind its status line's button. Renders nothing
 * for a topic added by hand that has none of this.
 */
export function TopicStructureBlock({ courseId, structure }: { courseId: string; structure: TopicStructure }) {
  const { objectives, prerequisites, sources } = structure
  if (objectives.length === 0 && prerequisites.length === 0 && sources.length === 0) return null

  return (
    <section aria-label="About this topic" className="mt-4 flex max-w-[68ch] flex-col gap-3 border-t border-border pt-4 sm:mt-5">
      {objectives.length > 0 ? (
        <div>
          <h2 className="text-body-strong text-fg">By the end you can</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-body text-fg-2 marker:text-fg-3">
            {objectives.map((objective, index) => (
              <li key={`${index}-${objective}`}>
                <MathText>{objective}</MathText>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prerequisites.length > 0 || sources.length > 0 ? (
        <dl className="flex flex-col gap-1.5">
          {prerequisites.length > 0 ? (
            <Row label="Builds on">
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {prerequisites.map((topic) => (
                  <li key={topic.id}>
                    <Link href={`/courses/${courseId}/topics/${topic.id}`} className={linkClass}>
                      <MathText>{topic.name}</MathText>
                    </Link>
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
          {sources.length > 0 ? (
            <Row label="Taught from">
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {sources.map((source) => (
                  <li
                    key={`${source.materialId ?? source.filename}|${source.pageStart ?? ''}|${source.pageEnd ?? ''}`}
                    className="flex min-w-0 items-start gap-1.5"
                  >
                    <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 text-fg-3 [&>svg]:size-4">
                      <SourceIcon filename={source.filename} />
                    </span>
                    <SourceLink source={source} className="min-w-0 break-words" />
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
        </dl>
      ) : null}
    </section>
  )
}
