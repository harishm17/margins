/**
 * What the source reader shows for a topic (spec §5.2, D10): the topic's primary chunks as text, in document
 * order, with the claims that give them "Focus here" marks and "Quick check" checks, the focus
 * questions, and the student's own margin notes. Server only.
 *
 * - Chunks are the topic's primary sources (`topic_sources`); a topic planned before sources existed reads
 *   from its mapped chunks, as content generation does.
 * - Chunks overlap by design; `stripOverlap` takes the repeated tail off the start of the next chunk.
 * - A topic with no concepts (before v3, or extraction failed) reads the same, with no marks and no checks.
 */

import { ownedTopic, type OwnedTopic } from '@/server/owned'
import { prisma } from '@/lib/db/prisma'
import { latestWarmupResults } from '@/lib/learning/warmup-session'
import { focusChunks } from '@/lib/learning/warmup-bracket'
import { isPdf } from '@/lib/chat/citations'
import { buildChecks, type CheckGrade, type ReaderClaimRef, type ReaderFocusQuestion } from './checks'
import { stripOverlap } from './strip-overlap'
import { VERDICT_LABELS, type CheckVerdict } from './take'

/** The reader shows at most this many passages (a topic's sources are a few dozen in practice). */
const MAX_PASSAGES = 400
/** Mapped chunks a topic without sources reads (the same number content generation uses). */
const MAPPED_LIMIT = 24
const NON_CONTENT_ROLES = ['syllabus', 'exam']

export type ReaderPassage = {
  chunkId: string
  text: string
  pageStart: number | null
  pageEnd: number | null
  /** A page divider ("p. 12") shows above this passage: its page differs from the one before. */
  divider: number | null
  /** The warm-up says the student is weak on what this passage covers. */
  focus: boolean
}

export type ReaderFile = { materialId: string; filename: string; pdf: boolean; passages: ReaderPassage[] }

export type ReaderFocusQuestionView = { objectiveIndex: number; question: string; chunkId: string | null }

/** A "Quick check" check as the browser gets it. The claim, its quote and its page stay on the server until the student reveals them. */
export type ReaderCheckView = {
  afterChunkId: string
  kind: 'focus' | 'claim'
  question: string
  claimId: string
  /** The grade the student already gave this check (the server has it, so it is not asked again after a new session or another device), or null. */
  graded: CheckGrade | null
}

export type MarginNoteView = {
  id: string
  chunkId: string
  kind: 'note' | 'question' | 'answer'
  text: string
  reply: { reply: string; checkQuestion: string } | null
  /** The tutor's verdict on an answer, or null (not an answer, or a reply the tutor could not check). */
  verdict: CheckVerdict | null
  /** The note an answer replies to (the question, or the answer before it whose reply ended in another question). */
  parentNoteId: string | null
  createdAt: string
}

export type ReaderData = {
  topicId: string
  files: ReaderFile[]
  focusQuestions: ReaderFocusQuestionView[]
  checks: ReaderCheckView[]
  notes: MarginNoteView[]
  /** Passages marked Focus here. */
  focusCount: number
}

type Chunk = {
  id: string
  materialId: string
  filename: string
  chunkIndex: number
  text: string
  pageStart: number | null
  pageEnd: number | null
  sectionHierarchy: string | null
}

const chunkSelect = {
  id: true,
  materialId: true,
  chunkIndex: true,
  chunkText: true,
  pageStart: true,
  pageEnd: true,
  sectionHierarchy: true,
  material: { select: { filename: true, uploadedAt: true } },
} as const

type ChunkRow = {
  id: string
  materialId: string
  chunkIndex: number
  chunkText: string
  pageStart: number | null
  pageEnd: number | null
  sectionHierarchy: string | null
  material: { filename: string; uploadedAt: Date }
}

const toChunk = (row: ChunkRow): Chunk => ({
  id: row.id,
  materialId: row.materialId,
  filename: row.material.filename,
  chunkIndex: row.chunkIndex,
  text: row.chunkText,
  pageStart: row.pageStart,
  pageEnd: row.pageEnd,
  sectionHierarchy: row.sectionHierarchy,
})

const byDocument = (a: ChunkRow, b: ChunkRow) =>
  a.material.uploadedAt.getTime() - b.material.uploadedAt.getTime() || a.materialId.localeCompare(b.materialId) || a.chunkIndex - b.chunkIndex

/** The chunks a topic is read from, in document order. */
export async function loadTopicChunks(topic: OwnedTopic): Promise<Chunk[]> {
  const topicId = topic.id
  const sources = await prisma.topicSource.findMany({
    where: { topicId, role: 'primary', material: { validationStatus: 'valid', role: { notIn: NON_CONTENT_ROLES } } },
    select: { materialId: true, chunkIndexStart: true, chunkIndexEnd: true },
  })
  let rows: ChunkRow[]
  if (sources.length > 0) {
    rows = await prisma.materialChunk.findMany({
      where: { OR: sources.map((s) => ({ materialId: s.materialId, chunkIndex: { gte: s.chunkIndexStart, lte: s.chunkIndexEnd } })) },
      select: chunkSelect,
    })
  } else {
    const mapped = await prisma.topicChunkMapping.findMany({
      where: { topicId, chunk: { material: { validationStatus: 'valid', role: { notIn: NON_CONTENT_ROLES } } } },
      orderBy: [{ relevanceScore: 'desc' }, { chunkId: 'asc' }],
      take: MAPPED_LIMIT,
      select: { chunk: { select: chunkSelect } },
    })
    rows = mapped.map((m) => m.chunk)
  }
  const seen = new Set<string>()
  return rows
    .sort(byDocument)
    .filter((row) => !seen.has(row.id) && !!seen.add(row.id))
    .slice(0, MAX_PASSAGES)
    .map(toChunk)
}

/** Where each chunk the reader shows sits, in reading order, without any text. */
export type ChunkRef = { id: string; materialId: string; chunkIndex: number }

/** The same chunks as `loadTopicChunks`, in the same order, as ids and positions only. */
export async function loadTopicChunkRefs(topic: OwnedTopic): Promise<ChunkRef[]> {
  const topicId = topic.id
  const sources = await prisma.topicSource.findMany({
    where: { topicId, role: 'primary', material: { validationStatus: 'valid', role: { notIn: NON_CONTENT_ROLES } } },
    select: { materialId: true, chunkIndexStart: true, chunkIndexEnd: true },
  })
  const select = { id: true, materialId: true, chunkIndex: true, material: { select: { uploadedAt: true } } } as const
  let rows: { id: string; materialId: string; chunkIndex: number; material: { uploadedAt: Date } }[]
  if (sources.length > 0) {
    rows = await prisma.materialChunk.findMany({
      where: { OR: sources.map((s) => ({ materialId: s.materialId, chunkIndex: { gte: s.chunkIndexStart, lte: s.chunkIndexEnd } })) },
      select,
    })
  } else {
    const mapped = await prisma.topicChunkMapping.findMany({
      where: { topicId, chunk: { material: { validationStatus: 'valid', role: { notIn: NON_CONTENT_ROLES } } } },
      orderBy: [{ relevanceScore: 'desc' }, { chunkId: 'asc' }],
      take: MAPPED_LIMIT,
      select: { chunk: { select } },
    })
    rows = mapped.map((m) => m.chunk)
  }
  const seen = new Set<string>()
  return rows
    .sort((a, b) => a.material.uploadedAt.getTime() - b.material.uploadedAt.getTime() || a.materialId.localeCompare(b.materialId) || a.chunkIndex - b.chunkIndex)
    .filter((row) => !seen.has(row.id) && !!seen.add(row.id))
    .slice(0, MAX_PASSAGES)
    .map(({ id, materialId, chunkIndex }) => ({ id, materialId, chunkIndex }))
}

/**
 * What `mergeOverlap(...).resolve` gives for these chunk ids, reading the text of only the chunks it must compare (each
 * wanted chunk and the one before it, further back only while those were merged too). An id that is not in `refs` is left out.
 */
export async function resolveMergedChunks(refs: ChunkRef[], wanted: Iterable<string>): Promise<Map<string, string>> {
  const position = new Map(refs.map((ref, index) => [ref.id, index]))
  const texts = new Map<string, string>()
  const load = async (ids: string[]) => {
    const missing = ids.filter((id) => !texts.has(id))
    if (missing.length === 0) return
    for (const row of await prisma.materialChunk.findMany({ where: { id: { in: missing } }, select: { id: true, chunkText: true } })) texts.set(row.id, row.chunkText)
  }
  const follows = (index: number) => index > 0 && refs[index - 1].materialId === refs[index].materialId && refs[index - 1].chunkIndex + 1 === refs[index].chunkIndex
  const wantedIndexes = [...new Set(wanted)].flatMap((id) => (position.has(id) ? [position.get(id) as number] : []))
  await load(wantedIndexes.flatMap((index) => (follows(index) ? [refs[index].id, refs[index - 1].id] : [])))
  const resolved = new Map<string, string>()
  for (const start of wantedIndexes) {
    let index = start
    // Step back while the chunk is only the repeated tail of the one before it.
    while (follows(index)) {
      await load([refs[index].id, refs[index - 1].id])
      if (stripOverlap(texts.get(refs[index - 1].id) ?? '', texts.get(refs[index].id) ?? '').trim()) break
      index -= 1
    }
    resolved.set(refs[start].id, refs[index].id)
  }
  return resolved
}

/**
 * Overlap comes off the start of a chunk that follows the one before it in the same file. A chunk that was
 * only overlap disappears, and `resolve` moves anything that pointed at it (a claim, a focus question) to the
 * chunk it was repeated in. The reader and the warm-up's focus count both go through this, so they agree.
 */
export function mergeOverlap(chunks: Chunk[]): { kept: { chunk: Chunk; text: string }[]; resolve: (chunkId: string | null) => string | null } {
  const merged = new Map<string, string>()
  const kept: { chunk: Chunk; text: string }[] = []
  let previous: Chunk | null = null
  for (const chunk of chunks) {
    const follows = previous && previous.materialId === chunk.materialId && previous.chunkIndex + 1 === chunk.chunkIndex
    const text = follows && previous ? stripOverlap(previous.text, chunk.text) : chunk.text
    if (follows && previous && !text.trim()) merged.set(chunk.id, kept[kept.length - 1]?.chunk.id ?? previous.id)
    else kept.push({ chunk, text })
    previous = chunk
  }
  return { kept, resolve: (chunkId) => (chunkId && merged.has(chunkId) ? (merged.get(chunkId) as string) : chunkId) }
}

async function loadClaims(topic: OwnedTopic): Promise<ReaderClaimRef[]> {
  const topicId = topic.id
  const rows = await prisma.conceptClaim.findMany({
    where: { concept: { topicId, status: 'active' } },
    orderBy: [{ concept: { orderIndex: 'asc' } }, { orderIndex: 'asc' }],
    select: { id: true, conceptId: true, text: true, quote: true, chunkId: true, pageStart: true, concept: { select: { name: true } } },
  })
  return rows.map((row) => ({ id: row.id, conceptId: row.conceptId, conceptName: row.concept.name, text: row.text, quote: row.quote, chunkId: row.chunkId, pageStart: row.pageStart }))
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

async function loadFocusQuestions(topic: OwnedTopic): Promise<ReaderFocusQuestion[]> {
  const topicId = topic.id
  const row = await prisma.topicContent.findUnique({ where: { topicId_contentType: { topicId, contentType: 'concept_prompts' } }, select: { contentData: true } })
  const questions: unknown[] = isRecord(row?.contentData) && Array.isArray(row.contentData.focus_questions) ? row.contentData.focus_questions : []
  return questions.filter(isRecord).flatMap((q) =>
    typeof q.question === 'string' && q.question.trim()
      ? [{ objectiveIndex: typeof q.objective_index === 'number' ? q.objective_index : 0, question: q.question.trim(), chunkId: typeof q.chunk_id === 'string' && q.chunk_id ? q.chunk_id : null }]
      : []
  )
}

const isVerdict = (value: unknown): value is CheckVerdict => typeof value === 'string' && value in VERDICT_LABELS

export function toNoteView(row: { id: string; chunkId: string; kind: string; text: string; reply: unknown; createdAt: Date }): MarginNoteView {
  const stored = isRecord(row.reply) ? row.reply : null
  const reply = stored && typeof stored.reply === 'string' ? { reply: stored.reply, checkQuestion: typeof stored.checkQuestion === 'string' ? stored.checkQuestion : '' } : null
  const kind = row.kind === 'question' || row.kind === 'answer' ? row.kind : 'note'
  return {
    id: row.id,
    chunkId: row.chunkId,
    kind,
    text: row.text,
    reply,
    verdict: kind === 'answer' && isVerdict(stored?.verdict) ? stored.verdict : null,
    parentNoteId: kind === 'answer' && typeof stored?.parentNoteId === 'string' ? stored.parentNoteId : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function loadMarginNotes(userId: string, topicId: string): Promise<MarginNoteView[]> {
  const rows = await prisma.marginNote.findMany({ where: { userId, topicId }, orderBy: { createdAt: 'asc' }, select: { id: true, chunkId: true, kind: true, text: true, reply: true, createdAt: true } })
  return rows.map(toNoteView)
}

/** The grade the student gave each of these checks, read back from the evidence it wrote (score 1, 0.5 or 0). */
async function gradedChecks(userId: string, claimIds: string[]): Promise<Map<string, CheckGrade>> {
  const out = new Map<string, CheckGrade>()
  if (claimIds.length === 0) return out
  const rows = await prisma.evidenceEvent.findMany({
    where: { userId, source: 'reader', itemKey: { in: claimIds.map((id) => `reader:${id}:check`) } },
    orderBy: { createdAt: 'asc' },
    select: { itemKey: true, score: true },
  })
  for (const row of rows) {
    const id = row.itemKey.slice('reader:'.length, -':check'.length)
    if (!out.has(id)) out.set(id, row.score >= 1 ? 'got_it' : row.score > 0 ? 'partly' : 'missed')
  }
  return out
}

/**
 * The reader for a topic, or null when the topic is not the user's. `files` is empty when the topic has no
 * text to read (the page then falls back to the generated notes).
 */
export async function loadReader(userId: string, topicId: string): Promise<ReaderData | null> {
  const topic = await ownedTopic(userId, topicId)
  if (!topic) return null
  const [chunks, claims, focusQuestions, notes, warmup] = await Promise.all([
    loadTopicChunks(topic),
    loadClaims(topic),
    loadFocusQuestions(topic),
    loadMarginNotes(userId, topicId),
    latestWarmupResults(userId, topicId),
  ])

  const files: ReaderFile[] = []
  const { kept, resolve } = mergeOverlap(chunks)
  const reading = claims.map((claim) => ({ ...claim, chunkId: resolve(claim.chunkId) }))

  const shown = new Set(kept.map((entry) => entry.chunk.id))
  const focusIds = new Set(warmup ? focusChunks(warmup, reading.map((c) => ({ conceptId: c.conceptId, chunkId: c.chunkId }))).filter((id) => shown.has(id)) : [])

  for (const { chunk, text } of kept) {
    let file = files[files.length - 1]
    if (!file || file.materialId !== chunk.materialId) {
      file = { materialId: chunk.materialId, filename: chunk.filename, pdf: isPdf(chunk.filename), passages: [] }
      files.push(file)
    }
    const before = file.passages[file.passages.length - 1]
    const page = chunk.pageStart
    // The divider shows when the page changes, and above the first passage of a file that has pages.
    const divider = page !== null && (!before || before.pageStart !== page) ? page : null
    file.passages.push({ chunkId: chunk.id, text, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, divider, focus: focusIds.has(chunk.id) })
  }

  const passages = kept.map(({ chunk }) => ({ chunkId: chunk.id, materialId: chunk.materialId, sectionHierarchy: chunk.sectionHierarchy }))
  const checks = buildChecks(passages, reading, focusQuestions.map((q) => ({ ...q, chunkId: resolve(q.chunkId) })))

  const graded = await gradedChecks(userId, checks.map((check) => check.claim.id))

  return {
    topicId,
    files,
    focusQuestions: focusQuestions.map((q) => ({ ...q, chunkId: shown.has(resolve(q.chunkId) ?? '') ? resolve(q.chunkId) : null })),
    checks: checks.map((check) => ({ afterChunkId: check.afterChunkId, kind: check.kind, question: check.question, claimId: check.claim.id, graded: graded.get(check.claim.id) ?? null })),
    notes,
    focusCount: focusIds.size,
  }
}

/** The topic's claims on one chunk, for the tutor and for the evidence an explanation writes. */
export async function claimsOnChunk(topic: OwnedTopic, chunkId: string): Promise<ReaderClaimRef[]> {
  return (await loadClaims(topic)).filter((claim) => claim.chunkId === chunkId)
}
