import { formatDate } from '@/lib/format'

/** The AI service names an exam "Sample Exam - 2026-10-20" (older exams) or "Mock exam - 2026-10-20". */
const GENERATED_NAME = /^(?:Sample|Mock) [Ee]xam - \d{4}-\d{2}-\d{2}$/

/** "Sorting, Hash tables" for one or two topics; "Sorting and 3 more" for more: a title that stays one line on a phone. */
export function topicsLabel(topics: readonly string[]): string {
  const names = topics.map((topic) => topic.trim()).filter((topic) => topic.length > 0)
  if (names.length <= 2) return names.join(', ')
  return `${names[0]} and ${names.length - 1} more`
}

/**
 * "Mock exam, Oct 20: Sorting, Hash tables" for generated names (dated by when the exam was made, and told apart
 * by the topics it covers when they are known); a custom name is kept as it is.
 */
export function examTitle(name: string, createdAt: string | Date, topics: readonly string[] = []): string {
  if (!GENERATED_NAME.test(name)) return name
  const covered = topicsLabel(topics)
  return covered ? `Mock exam, ${formatDate(createdAt)}: ${covered}` : `Mock exam, ${formatDate(createdAt)}`
}

type TitledExam = { id: string; name: string; createdAt: string | Date; topicsCovered?: readonly string[] }

/**
 * Titles for all the exams of one course, with no two alike. A generated name carries a date and the topics
 * covered; two exams of the same day over the same topics would still read alike, so the second and later ones
 * (by creation time) get " (2)", " (3)". A custom name is kept as the student wrote it.
 */
export function examTitles(exams: readonly TitledExam[]): Map<string, string> {
  const ordered = [...exams].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const seen = new Map<string, number>()
  const titles = new Map<string, string>()
  for (const exam of ordered) {
    const base = examTitle(exam.name, exam.createdAt, exam.topicsCovered)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    titles.set(exam.id, count === 1 ? base : `${base} (${count})`)
  }
  return titles
}
