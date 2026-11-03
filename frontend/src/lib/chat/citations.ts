/**
 * Citations on a chat answer.
 *
 * The AI service cites whole chunks of the student's files. A cited chunk is a "source"
 * (numbered 1, 2, ... by first citation) and a "mark" says where its number goes in the
 * answer text. Assistant messages store `{ sources, marks }` in `ChatMessage.citations`.
 */

export type ChatSource = {
  marker: number
  chunkId: string
  materialId: string
  filename: string
  pageStart: number | null
  pageEnd: number | null
  section: string | null
  citedText: string
}

export type CitationMark = {
  /** Characters from the start of the answer text. */
  offset: number
  marker: number
}

export type StoredCitations = {
  sources: ChatSource[]
  marks: CitationMark[]
}

export const EMPTY_CITATIONS: StoredCitations = { sources: [], marks: [] }

/** The in-text link target for a marker; the markdown renderer turns these into buttons. */
export const CITE_HREF_PREFIX = '#cite-'

export function citeHref(marker: number): string {
  return `${CITE_HREF_PREFIX}${marker}`
}

/** The marker number in an in-text link target, or null for any other link. */
export function markerFromHref(href: string | undefined | null): number | null {
  if (!href || !href.startsWith(CITE_HREF_PREFIX)) return null
  const value = Number(href.slice(CITE_HREF_PREFIX.length))
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Put `[n](#cite-n)` links into the answer at each mark.
 *
 * A mark sits where the cited text ended, which is often after a space or line break, so it
 * moves back over trailing whitespace to hug the last word. Marks past the end of the text
 * land at the end. Several marks at one place come out in marker order, each once.
 */
export function insertCitationMarkers(text: string, marks: readonly CitationMark[]): string {
  if (marks.length === 0) return text

  const positions = new Map<number, number[]>()
  for (const mark of marks) {
    let position = Math.max(0, Math.min(Math.floor(mark.offset), text.length))
    while (position > 0 && /\s/.test(text[position - 1])) position -= 1
    const markers = positions.get(position) ?? []
    if (!markers.includes(mark.marker)) markers.push(mark.marker)
    positions.set(position, markers)
  }

  let result = ''
  let last = 0
  for (const position of [...positions.keys()].sort((a, b) => a - b)) {
    result += text.slice(last, position)
    const markers = [...(positions.get(position) ?? [])].sort((a, b) => a - b)
    result += markers.map((marker) => `[${marker}](${citeHref(marker)})`).join('')
    last = position
  }
  return result + text.slice(last)
}

/** A cited quote for display: the chunk text is markdown, so heading marks ("## ") are dropped. */
export function quoteForDisplay(citedText: string): string {
  return citedText.replace(/^#{1,6}[ \t]+/gm, '').trim()
}

/** A cited quote on one line, for a place that shows it inside a sentence: heading marks dropped, line breaks as spaces. */
export function quoteOnOneLine(citedText: string): string {
  return quoteForDisplay(citedText).replace(/\s*\n+\s*/g, ' ')
}

export function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf')
}

/** "p. 4", "pp. 4-5", or null when the source has no pages (DOCX, PPTX). */
export function pageLabel(source: Pick<ChatSource, 'pageStart' | 'pageEnd'>): string | null {
  if (!source.pageStart) return null
  if (!source.pageEnd || source.pageEnd === source.pageStart) return `p. ${source.pageStart}`
  return `pp. ${source.pageStart}-${source.pageEnd}`
}

/** "notes.pdf, p. 4" or "slides.pptx, Week 2 > Hashing" or just the file name. */
export function sourceLabel(source: ChatSource): string {
  const pages = pageLabel(source)
  if (pages) return `${source.filename}, ${pages}`
  const section = source.section?.trim()
  return section ? `${source.filename}, ${section}` : source.filename
}

/** Where a source opens: the PDF at its first cited page, or the file route for other types. */
export function viewerUrl(source: Pick<ChatSource, 'materialId' | 'filename' | 'pageStart'>): string {
  const base = `/api/materials/${encodeURIComponent(source.materialId)}/file`
  return isPdf(source.filename) && source.pageStart ? `${base}#page=${source.pageStart}` : base
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** A source as the AI service sends it (snake_case) or as stored (camelCase). */
export function parseSource(value: unknown): ChatSource | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const marker = asNumberOrNull(raw.marker)
  const chunkId = asStringOrNull(raw.chunk_id ?? raw.chunkId)
  const materialId = asStringOrNull(raw.material_id ?? raw.materialId)
  if (marker === null || !chunkId || !materialId) return null
  return {
    marker,
    chunkId,
    materialId,
    filename: asStringOrNull(raw.filename) ?? 'material',
    pageStart: asNumberOrNull(raw.page_start ?? raw.pageStart),
    pageEnd: asNumberOrNull(raw.page_end ?? raw.pageEnd),
    section: asStringOrNull(raw.section),
    citedText: typeof (raw.cited_text ?? raw.citedText) === 'string' ? String(raw.cited_text ?? raw.citedText) : '',
  }
}

export function parseMarks(value: unknown): CitationMark[] {
  if (!Array.isArray(value)) return []
  const marks: CitationMark[] = []
  for (const item of value) {
    const offset = asNumberOrNull((item as Record<string, unknown> | null)?.offset)
    const marker = asNumberOrNull((item as Record<string, unknown> | null)?.marker)
    if (offset !== null && marker !== null && offset >= 0 && marker > 0) marks.push({ offset, marker })
  }
  return marks
}

/** Whatever is in the database column, as a safe `StoredCitations`. */
export function parseStoredCitations(value: unknown): StoredCitations {
  if (!value || typeof value !== 'object') return EMPTY_CITATIONS
  const raw = value as Record<string, unknown>
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map(parseSource).filter((s): s is ChatSource => s !== null)
    : []
  const known = new Set(sources.map((s) => s.marker))
  return { sources, marks: parseMarks(raw.marks).filter((m) => known.has(m.marker)) }
}

/** The citations of a finished answer in the form stored on the message. */
export function toStoredCitations(sources: readonly ChatSource[], marks: readonly CitationMark[]): StoredCitations {
  return { sources: [...sources], marks: [...marks] }
}
