/**
 * The topic's key terms for the voice coach (spec §19.5): the concepts' names, then salient terms from their claims, at most
 * MAX_COURSE_TERMS. The browser's recogniser mishears technical words ("Dijkstra", "eigenvalue", "O of n"); the coach prompt lists
 * the terms so the model maps a misheard word to the one meant, and the browser hands the same list to on-device recognition.
 * `selectCourseTerms` is pure; `courseTermsForTopics` reads the database.
 */
import { prisma } from '@/lib/db/prisma'

export const MAX_COURSE_TERMS = 100
const MAX_TERM_CHARS = 60

/** Common long words that are not course terms. */
const COMMON = new Set(
  (
    'according although another because becomes before between building certain changes choosing combined completely consider ' +
    'containing continues contains correct created depends describes different directly distinct elements entirely especially ' +
    'essential example examples existing explains following frequently function generally given happens however identical ' +
    'important including increase instead involves itself keeping knowledge language leaving looking makes meaning ' +
    'multiple necessary neither normally number numbers object objects obtain operation otherwise overall particular perform ' +
    'possible practice previous problem process produce provides rather reading reasons regular related relation remains ' +
    'require requires result results returns several should similar simple single someone something sometimes specific standard ' +
    'starting storing student students suppose through together towards typical typically understand unique usually various ' +
    'whatever whenever whether without working written therefore finally firstly secondly additionally moreover hence usually instead otherwise sometimes everything anything nothing'
  ).split(' ')
)

/** One term, cleaned: tags and line breaks cannot get into the prompt, and quotes and trailing punctuation are dropped. */
function clean(term: string): string {
  return term
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`([]+/, '')
    .replace(/[\s"'`.,;:!?)\]]+$/, '')
    .trim()
}

type Candidate = { term: string; score: number; first: number }

/** Terms that stand out in a claim: quoted, an acronym, an identifier, hyphenated, a capitalised name inside a sentence, or a long word. */
function termsOfClaim(text: string): { term: string; weight: number }[] {
  const found: { term: string; weight: number }[] = []
  for (const match of text.matchAll(/["“”‘’`]([^"“”‘’`\n]{2,40})["“”‘’`]/g)) found.push({ term: match[1], weight: 3 })
  for (const match of text.matchAll(/\b[A-Z]{2,}[a-z]?s?\b/g)) found.push({ term: match[0], weight: 3 })
  for (const match of text.matchAll(/\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g)) found.push({ term: match[0], weight: 3 })
  for (const match of text.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g)) found.push({ term: match[0], weight: 2 })
  // A capitalised word (or run of them) that does not start a sentence.
  for (const match of text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\b/g)) found.push({ term: match[1], weight: 2 })
  // A capitalised word of six letters or more is a name or a term even where it starts a sentence; a short or lowercase one has to be long.
  for (const match of text.matchAll(/\b(?:[A-Z][a-z]{5,}|[A-Za-z]{9,})\b/g)) {
    const word = match[0]
    if (!COMMON.has(word.toLowerCase())) found.push({ term: word, weight: 1 })
  }
  return found
}

/** Concept names first, then claim terms by how much they stand out and how often they appear. Duplicates (any case) are dropped. */
export function selectCourseTerms(input: { conceptNames: string[]; claimTexts: string[] }, max = MAX_COURSE_TERMS): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  const add = (raw: string): boolean => {
    const term = clean(raw)
    const key = term.toLowerCase()
    if (term.length < 2 || term.length > MAX_TERM_CHARS || seen.has(key)) return false
    seen.add(key)
    terms.push(term)
    return true
  }
  for (const name of input.conceptNames) {
    if (terms.length >= max) return terms
    add(name)
  }
  const candidates = new Map<string, Candidate>()
  let position = 0
  for (const text of input.claimTexts) {
    for (const { term, weight } of termsOfClaim(text)) {
      const cleaned = clean(term)
      const key = cleaned.toLowerCase()
      if (cleaned.length < 2 || seen.has(key)) continue
      const entry = candidates.get(key) ?? { term: cleaned, score: 0, first: position++ }
      entry.score += weight
      candidates.set(key, entry)
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.first - b.first)
  for (const candidate of ranked) {
    if (terms.length >= max) break
    add(candidate.term)
  }
  return terms
}

/**
 * The terms of the active concepts of these topics, in the order of the course. Only the student's own topics count: the
 * ids come from a stored session and its question set, so the query filters through the course's owner (SEC-L1).
 */
export async function courseTermsForTopics(userId: string, topicIds: string[]): Promise<string[]> {
  if (topicIds.length === 0) return []
  const concepts = await prisma.concept.findMany({
    where: { topicId: { in: topicIds }, status: 'active', project: { userId } },
    orderBy: [{ topic: { orderIndex: 'asc' } }, { orderIndex: 'asc' }],
    select: { name: true, claims: { orderBy: { orderIndex: 'asc' }, select: { text: true } } },
  })
  return selectCourseTerms({
    conceptNames: concepts.map((concept) => concept.name),
    claimTexts: concepts.flatMap((concept) => concept.claims.map((claim) => claim.text)),
  })
}

/** The topics a session works on: its topic, or the topics of a sprint's questions. */
export function sessionTopicIds(session: { topicId: string | null; questionSet: unknown }): string[] {
  const ids = new Set<string>()
  if (session.topicId) ids.add(session.topicId)
  if (Array.isArray(session.questionSet)) {
    for (const question of session.questionSet as Array<{ topic_id?: unknown }>) {
      if (typeof question?.topic_id === 'string' && question.topic_id) ids.add(question.topic_id)
    }
  }
  return [...ids]
}
