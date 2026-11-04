import * as React from 'react'

/** A legal page: a 680px reading column, the last updated date, then h2 sections. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-10 md:px-8 md:pt-16">
      <h1 className="text-title text-fg">{title}</h1>
      <div className="mt-6 flex flex-col gap-5 text-reading text-fg-2">{children}</div>
    </article>
  )
}

/** One line per item, each starting with the bold name of what it is about. */
export function LegalList({ items }: { items: { name: string; text: React.ReactNode }[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.name}>
          <span className="font-medium text-fg">{item.name}.</span> {item.text}
        </li>
      ))}
    </ul>
  )
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="mt-5 text-reading-h2 text-fg">{heading}</h2>
      {children}
    </section>
  )
}
