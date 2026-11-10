import { withPrisma } from '../../e2e/helpers/db'

/** One question of a mock exam as stored, in the order the exam shows it. */
export type ExamQuestion = { topicId: string | null; type: string; points: number; text: string }

/** The exam's questions as stored (sample_exams.questions): "Question n" on screen is the n-th. */
export async function examQuestions(examId: string): Promise<ExamQuestion[]> {
  return withPrisma(async (prisma) => {
    const [row] = await prisma.$queryRawUnsafe<{ questions: unknown }[]>('SELECT "questions" FROM "sample_exams" WHERE "id" = $1', examId)
    if (!row || !Array.isArray(row.questions)) throw new Error(`No exam ${examId}`)
    return row.questions.map((raw) => {
      const question = (raw ?? {}) as Record<string, unknown>
      return {
        topicId: typeof question.topic_id === 'string' ? question.topic_id : null,
        type: String(question.question_type ?? ''),
        points: typeof question.points === 'number' ? question.points : 1,
        text: String(question.question_text ?? ''),
      }
    })
  })
}

/** The course's topics in course order, by id and name. */
export async function courseTopics(courseId: string): Promise<{ id: string; name: string }[]> {
  return withPrisma((prisma) =>
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
      'SELECT "id", "name" FROM "topics" WHERE "project_id" = $1 ORDER BY "order_index", "name"',
      courseId
    )
  )
}

/** Choice questions first, then short written ones, then the rest (longer answers, proofs). */
const LENGTH: Record<string, number> = { multiple_choice: 0, true_false: 0, short_answer: 1, numerical: 1 }
const lengthOf = (type: string) => LENGTH[type] ?? 2

/**
 * U8: an exam goes topic by topic in course order, each topic from its choice questions to its longer ones, and
 * does not open on its one highest-point question. Returns what breaks that, by question number.
 */
export function orderProblems(questions: readonly Omit<ExamQuestion, 'text'>[], courseOrder: readonly string[]): string[] {
  const problems: string[] = []
  const done = new Set<string>()
  questions.forEach((question, index) => {
    const previous = questions[index - 1]
    const at = `question ${index + 1}`
    if (!previous || previous.topicId === question.topicId) {
      if (previous && lengthOf(question.type) < lengthOf(previous.type)) problems.push(`${at} (${question.type}) comes after a longer question of its topic`)
    } else if (question.topicId && done.has(question.topicId)) problems.push(`${at} goes back to an earlier topic`)
    else if (courseOrder.indexOf(question.topicId ?? '') < courseOrder.indexOf(previous.topicId ?? '')) {
      problems.push(`${at} is on a topic that comes earlier in the course`)
    }
    if (previous?.topicId) done.add(previous.topicId)
  })
  const top = Math.max(...questions.map((question) => question.points))
  if (questions.length > 1 && questions[0].points === top && questions.filter((question) => question.points === top).length === 1) {
    problems.push(`question 1 is the exam's hardest (${top} points)`)
  }
  return problems
}

/** 27: questions that keep a past exam's header ("Problem 3.") or its points ("[5 points]"), by number only. */
export function copiedHeaders(texts: readonly string[]): string[] {
  return texts.flatMap((text, index) =>
    /^\W*Problem \d+\s*[.:]/i.test(text) || /\[\d+(\.\d+)? points?\]/i.test(text) ? [`question ${index + 1}`] : []
  )
}

/** U7: surfaces whose text names the exam neither by its short name nor by its full one. */
export function nameProblems(readings: readonly { surface: string; text: string }[], short: string, full: string): string[] {
  return readings.filter(({ text }) => !text.includes(short) && !text.includes(full)).map(({ surface, text }) => `${surface}: "${text}"`)
}

/** Every reading, when one figure is written more than one way across surfaces; empty when they agree. */
export function differing(readings: readonly { surface: string; value: string }[]): string[] {
  return new Set(readings.map((reading) => reading.value)).size > 1 ? readings.map(({ surface, value }) => `${surface}: ${value}`) : []
}
