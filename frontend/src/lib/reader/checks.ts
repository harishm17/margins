// "Before you go on" checks inside the reading (spec §5.2): after each section that holds a claim, one short
// question. It is the section's focus question when one points into it, else a claim turned into a question.
// The student answers, reveals the source sentence and grades themselves (level 2, self-graded). Pure.

export type ReaderPassageRef = { chunkId: string; materialId: string; sectionHierarchy: string | null }

export type ReaderClaimRef = {
  id: string
  conceptId: string
  conceptName: string
  text: string
  quote: string
  chunkId: string | null
  pageStart: number | null
}

export type ReaderFocusQuestion = { objectiveIndex: number; question: string; chunkId: string | null }

export type ReaderCheck = {
  /** The passage the check follows: the last of its section. */
  afterChunkId: string
  kind: 'focus' | 'claim'
  question: string
  /** The claim whose source sentence is revealed, and whose concepts the self-grade is filed under. */
  claim: ReaderClaimRef
}

/** A section with no heading is cut after this many passages, so a long file still gets a check now and then. */
export const MAX_SECTION_PASSAGES = 4

/** Consecutive passages of one file under one heading, in reading order. */
export function sectionsOf<T extends ReaderPassageRef>(passages: T[]): T[][] {
  const sections: T[][] = []
  for (const passage of passages) {
    const current = sections[sections.length - 1]
    const last = current?.[current.length - 1]
    if (current && last && last.materialId === passage.materialId && last.sectionHierarchy === passage.sectionHierarchy && current.length < MAX_SECTION_PASSAGES) {
      current.push(passage)
    } else {
      sections.push([passage])
    }
  }
  return sections
}

/** At most one check per section, and only for a section that holds a claim. */
export function buildChecks(passages: ReaderPassageRef[], claims: ReaderClaimRef[], focusQuestions: ReaderFocusQuestion[]): ReaderCheck[] {
  const checks: ReaderCheck[] = []
  for (const section of sectionsOf(passages)) {
    const ids = new Set(section.map((p) => p.chunkId))
    const held = claims.filter((claim) => claim.chunkId !== null && ids.has(claim.chunkId))
    if (held.length === 0) continue
    const afterChunkId = section[section.length - 1].chunkId
    const focus = focusQuestions.find((q) => q.chunkId !== null && ids.has(q.chunkId))
    if (focus) {
      const claim = held.find((c) => c.chunkId === focus.chunkId) ?? held[0]
      checks.push({ afterChunkId, kind: 'focus', question: focus.question, claim })
    } else {
      const claim = held[0]
      checks.push({ afterChunkId, kind: 'claim', question: `What does the reading say about ${claim.conceptName}?`, claim })
    }
  }
  return checks
}

export type CheckGrade = 'got_it' | 'partly' | 'missed'

/** The score a self-grade is recorded with (for display: level 2 never drives the memory). */
export const checkScore = (grade: CheckGrade): number => (grade === 'got_it' ? 1 : grade === 'partly' ? 0.5 : 0)
