import type { CheckGrade } from '@/lib/reader/checks'

const GRADE_IDS: CheckGrade[] = ['got_it', 'partly', 'missed']

export type Settled = { state: 'done'; grade: CheckGrade; counted: boolean } | { state: 'skipped' }

/**
 * What a student did with a check before a reload, read from the stored text. A record saved before the
 * `counted` field existed was a counted grade, so it reads as counted.
 */
export function parseSettled(raw: string | null): Settled | null {
  try {
    const stored = JSON.parse(raw ?? 'null') as { state?: unknown; grade?: unknown; counted?: unknown } | null
    if (!stored) return null
    if (stored.state === 'skipped') return { state: 'skipped' }
    if (stored.state === 'done' && GRADE_IDS.includes(stored.grade as CheckGrade)) {
      return { state: 'done', grade: stored.grade as CheckGrade, counted: stored.counted !== false }
    }
  } catch {
    // An unreadable record is no record.
  }
  return null
}
