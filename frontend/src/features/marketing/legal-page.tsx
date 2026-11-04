import * as React from 'react'
import { phoneRow } from '@/components/ui/styles'

/** A legal page: a 680px reading column, the last updated date, then h2 sections. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-10 md:px-8 md:pt-16">
      <h1 className="text-title text-fg">{title}</h1>
      <div className="mt-6 flex flex-col gap-5 text-reading text-fg-2">{children}</div>
    </article>
  )
}

/** One line per item, each starting with the bold name of what it is about and a colon ("Your account: ..."). */
export function LegalList({ items }: { items: { name: string; text: React.ReactNode }[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.name}>
          <span className="font-medium text-fg">{item.name}:</span> {item.text}
        </li>
      ))}
    </ul>
  )
}

/** Jump links to the page's sections, above the first one: a long policy on a phone is found by its labels. One link per row on a phone (44px each), side by side from 640px. */
export function LegalContents({ sections }: { sections: { id: string; heading: string }[] }) {
  return (
    <nav aria-label="On this page">
      <ul className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-5 text-small">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={`${phoneRow} rounded-chip text-accent underline underline-offset-4 hover:text-accent-hover`}
            >
              {section.heading}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function LegalSection({ heading, id, children }: { heading: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <h2 className="mt-5 text-reading-h2 text-fg">{heading}</h2>
      {children}
    </section>
  )
}
