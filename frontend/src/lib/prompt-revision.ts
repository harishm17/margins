/**
 * Which areas use the audited (v2) prompts of the 2026-11-09 prompt audit. The server-side twin of
 * ai-service/app/prompt_revision.py.
 *
 * `PROMPTS_V2` is a comma-separated list of areas, or "all". Empty (the default) keeps every area on its
 * v1 prompts. It is a server-only variable (no NEXT_PUBLIC_ prefix), so it is never in the browser bundle.
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
