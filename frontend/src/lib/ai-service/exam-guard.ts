import { logServerError } from '@/lib/ops/log'
import { aiServiceHeaders } from '@/lib/ai-service/headers'

/** Longest the meaning check may take: it runs in front of the answer, so a slow check is skipped, not waited for. */
export const SEMANTIC_GUARD_TIMEOUT_MS = 4_000

/**
 * Whether the AI service finds the message close in meaning to one of the open exam's questions (reworded with
 * synonyms, or in another language), reading the student's last messages with it. The word check ran first; this one
 * is the second line. A service that cannot answer leaves the word check's verdict standing (the message goes on), and
 * the failure is logged.
 */
export async function semanticExamMatch(input: { message: string; recent: readonly string[]; examTexts: readonly string[] }): Promise<boolean> {
  if (input.examTexts.length === 0) return false
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000'
  try {
    const response = await fetch(`${aiServiceUrl}/chat/exam-guard`, {
      method: 'POST',
      headers: aiServiceHeaders(),
      body: JSON.stringify({ message: input.message, recent: input.recent.slice(-3), exam_texts: input.examTexts.slice(0, 200) }),
      signal: AbortSignal.timeout(SEMANTIC_GUARD_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { match?: unknown }
    return body.match === true
  } catch (error) {
    logServerError('Chat: the exam guard meaning check did not run', error)
    return false
  }
}
