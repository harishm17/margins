/**
 * Page references in the voice summary: the label shown for a claim's pages, the references a label of free text names
 * (ranges, "pp.", "page N", lists), and which link a label belongs to. The label of a claim is made from its structured
 * pages (pageStart, pageEnd); parsing is for the labels that arrive as text.
 */

export type PageRef = { start: number; end: number }
type Link = { label: string; href: string }

/** "p. 5" for one page, "pp. 5-7" for a range. */
export function pageLabel(start: number, end?: number | null): string {
  return end && end > start ? `pp. ${start}-${end}` : `p. ${start}`
}

const KEYWORD = /\b(?:pp|p|pages?)\b\.?\s*/gi
const ITEM = /(\d{1,5})(?:\s*(?:-|–|—|to)\s*(\d{1,5}))?/y
const SEPARATOR = /\s*(?:,|;|&|\band\b)\s*/y

/** The pages a text names: "p. 5", "pp. 4-6", "page 5", "pages 4 and 6", "p. 4, 6-7". A range that runs backwards is the page it starts on. */
export function parsePageRefs(text: string): PageRef[] {
  const refs: PageRef[] = []
  for (const keyword of text.matchAll(KEYWORD)) {
    let at = (keyword.index ?? 0) + keyword[0].length
    for (;;) {
      ITEM.lastIndex = at
      const item = ITEM.exec(text)
      if (!item) break
      const start = Number(item[1])
      const end = item[2] ? Number(item[2]) : start
      refs.push({ start, end: end >= start ? end : start })
      at = ITEM.lastIndex
      SEPARATOR.lastIndex = at
      const separator = SEPARATOR.exec(text)
      if (!separator) break
      at = SEPARATOR.lastIndex
    }
  }
  return refs
}

const overlaps = (a: PageRef, b: PageRef) => a.start <= b.end && b.start <= a.end

/** The link a page label belongs to: the one with the same label, else the first whose pages overlap the label's. */
export function linkForLabel<T extends Link>(label: string, links: T[]): T | undefined {
  const same = links.find((link) => link.label === label)
  if (same) return same
  const wanted = parsePageRefs(label)
  if (wanted.length === 0) return undefined
  return links.find((link) => parsePageRefs(link.label).some((ref) => wanted.some((want) => overlaps(ref, want))))
}
