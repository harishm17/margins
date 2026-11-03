import type { ExpectedMissSurface } from './expected-miss-rules'

/**
 * The lines that say, where failure happens, that missing is expected (spec §18.10). Drafts: the words are
 * Harish's to finalise. `{page}` is filled by `expectedMissText`.
 */
export const EXPECTED_MISS_COPY: Record<ExpectedMissSurface, string> = {
  warmup_results: "You haven't read this yet, so misses here are expected. They mark where to look.",
  practice_miss: 'Missing a step is part of practice. The next try, or a hint, is where it sticks.',
  practice_none_solved: 'None of these came easily, which is common the first time. Read p. {page} again, or try a similar problem.',
  recall_idk: "That's fine. Here's where to look.",
  recall_gaps: 'Gaps are normal on a first recall. They show you what to read again.',
  review_summary: "That was a hard set, and that's normal at this stage. Here's what to look at.",
  quiz_results: 'A low first score is common, and useful: the misses show where to spend your time.',
  progress_early: 'Early weeks are usually low; this measures first tries only.',
}

// Used when no page is known for the passage.
const NONE_SOLVED_WITHOUT_PAGE = 'None of these came easily, which is common the first time. Read that section again, or try a similar problem.'

/** The line for a surface, with the page filled in where the line names one. */
export function expectedMissText(surface: ExpectedMissSurface, fill: { page?: number | null } = {}): string {
  const text = EXPECTED_MISS_COPY[surface]
  if (!text.includes('{page}')) return text
  return typeof fill.page === 'number' ? text.replace('{page}', String(fill.page)) : NONE_SOLVED_WITHOUT_PAGE
}

/** The explainer gate's secondary action; it replaces "The pages don't explain this well: open the explainer anyway". */
export const EXPLAINER_ESCAPE_LABEL = "I'd rather read an explanation now"

/** An instruction for the voice coach, not text shown to the student: the voice teach-back when nothing was covered. */
export const VOICE_NOTHING_COVERED_INSTRUCTION =
  'Say in a few words that it is fine not to have it yet, then explain.'
