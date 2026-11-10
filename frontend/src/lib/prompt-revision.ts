/**
 * Which areas use the audited (v2) prompts of the 2026-11-09 prompt audit. The server-side twin of
 * ai-service/app/prompt_revision.py.
 *
 * `PROMPTS_V2` is a comma-separated list of areas, or "all". Empty (the default) keeps every area on its
 * v1 prompts. It is a server-only variable (no NEXT_PUBLIC_ prefix), so it is never in the browser bundle.
 * A name that is not an area stops the server at start (instrumentation.ts), so a misspelt area is not silently left on v1.
 * Once an area has run on v2 in production, its v1 text and this check are deleted.
 */

export const PROMPT_AREAS = ['generation', 'support', 'tutor', 'grading', 'ask', 'ingest', 'voice'] as const
export type PromptArea = (typeof PROMPT_AREAS)[number]

/** `raw` is the variable's value; it defaults to the server's environment. */
export function promptsV2(area: PromptArea, raw: string | undefined = process.env.PROMPTS_V2): boolean {
  if (!(PROMPT_AREAS as readonly string[]).includes(area)) throw new Error(`Unknown prompt area "${area}": add it to PROMPT_AREAS in prompt-revision.ts`)
  const listed = new Set(
    (raw ?? '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
  )
  return listed.has('all') || listed.has(area)
}

/** Throws when the variable lists a name that is neither an area nor "all" (a misspelt area used to be ignored). */
export function checkPromptAreas(raw: string | undefined = process.env.PROMPTS_V2): void {
  const known = new Set<string>(['all', ...PROMPT_AREAS])
  const unknown = (raw ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !known.has(part))
  if (unknown.length > 0) {
    throw new Error(`PROMPTS_V2 names unknown areas: ${[...new Set(unknown)].sort().join(', ')}. Known: all, ${PROMPT_AREAS.join(', ')}`)
  }
}

/** The areas on v2, in the form the services log at start: `areas=voice,ask` or `areas=none` (R9: compare the two services' lines). */
export function activePromptAreas(raw: string | undefined = process.env.PROMPTS_V2): string {
  const on = PROMPT_AREAS.filter((area) => promptsV2(area, raw))
  return `areas=${on.length > 0 ? on.join(',') : 'none'}`
}
