/**
 * What to tell a student when a job failed. The words come from the shared table in
 * lib/ai/messages (one table for jobs, chat, voice and refusals); this module adds what is
 * particular to jobs: content-type labels and the failures worth showing on a course.
 */

import { FALLBACK_MESSAGE, aiMessage, type AiMessage } from '@/lib/ai/messages'

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  section_notes: 'Section notes',
  solved_examples: 'Solved examples',
  interactive_examples: 'Interactive examples',
  topic_quiz: 'Topic quiz',
}

export const contentTypeLabel = (contentType: string): string =>
  CONTENT_TYPE_LABELS[contentType] ?? 'Content'

export const FALLBACK_FAILURE_MESSAGE = FALLBACK_MESSAGE.text

/** The full message (title, text, tone, retry) for a failed job. */
export function jobFailureMessage(errorCode: string | null | undefined, jobType?: string | null): AiMessage {
  return aiMessage(errorCode, jobType)
}

/** The text for a failed job. The job's own error message is never shown (it is written for logs). */
export function describeJobFailure(
  errorCode: string | null | undefined,
  _errorMessage?: string | null,
  jobType?: string | null
): string {
  return aiMessage(errorCode, jobType).text
}

/** "content:<topicId>:<contentType>" as stored on a generation job, or null for any other key. */
export function parseContentTarget(
  targetKey: string | null | undefined
): { topicId: string; contentType: string } | null {
  const match = /^content:([^:]+):([a-z_]+)$/.exec(targetKey ?? '')
  return match ? { topicId: match[1], contentType: match[2] } : null
}

export type GenerationJobRow = {
  targetKey: string | null
  status: string
  errorCode: string | null
  errorMessage: string | null
  id: string
}

export type GenerationFailure = {
  jobId: string
  topicId: string
  contentType: string
  errorCode: string | null
  message: string
}

/**
 * The failures worth showing: for each topic and content type, the most recent job counts
 * (rows must be newest first). It is a failure only if that job failed and the content is
 * still missing, so a later success or a later retry in progress clears it.
 */
export function pickGenerationFailures(
  rows: GenerationJobRow[],
  hasContent: (topicId: string, contentType: string) => boolean
): GenerationFailure[] {
  const seen = new Set<string>()
  const failures: GenerationFailure[] = []
  for (const row of rows) {
    const target = parseContentTarget(row.targetKey)
    if (!target || !row.targetKey || seen.has(row.targetKey)) continue
    seen.add(row.targetKey)
    if (row.status !== 'failed') continue
    if (hasContent(target.topicId, target.contentType)) continue
    failures.push({
      jobId: row.id,
      topicId: target.topicId,
      contentType: target.contentType,
      errorCode: row.errorCode,
      message: describeJobFailure(row.errorCode, row.errorMessage, 'generate_content'),
    })
  }
  return failures
}
