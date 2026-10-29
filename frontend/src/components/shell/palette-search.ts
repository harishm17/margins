import { defaultFilter } from 'cmdk'

/**
 * How the command palette tells its items apart and matches them. cmdk selects and highlights by
 * `value`, so two items with the same value (two files called notes.pdf in one course) highlight
 * together and the arrow keys can't get past the first. Every value is therefore the entry's own id
 * (with a prefix for the Recent copies), and matching runs on what the student sees instead: the
 * label and hint first, then the entry's keywords.
 */

type Searchable = { id: string; label: string; hint?: string; keywords?: string[] }

export function paletteItem(entry: Searchable, prefix = ''): { value: string; keywords: string[] } {
  return {
    value: `${prefix}${entry.id}`,
    keywords: [`${entry.label} ${entry.hint ?? ''}`.trim(), ...(entry.keywords ?? [])],
  }
}

/** The palette's filter: cmdk's own scoring over the visible text and keywords, never the id. */
export function paletteFilter(_value: string, search: string, keywords: string[] = []): number {
  const [text = '', ...rest] = keywords
  return defaultFilter(text, search, rest)
}
