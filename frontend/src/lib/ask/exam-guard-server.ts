/** The exam guard's server side (spec §6.3): the questions of the mock exam the student is taking, and the reply that declines. */

import { prisma } from '@/lib/db/prisma'
import { semanticExamMatch } from '@/lib/ai-service/exam-guard'
import { examGuard, examQuestionTexts } from './exam-guard'

/** The decline. No model is called for it. */
export const EXAM_GUARD_REPLY = "That looks like a question from the mock exam you're taking. Finish it first, then ask me."

/** What a declined message is kept as, and the title of a thread it started: the exam question itself is not stored. */
export const EXAM_GUARD_NOTE = 'A question from the mock exam in progress. It is not kept.'
export const EXAM_GUARD_TITLE = 'Question from a mock exam'

/** `stop_reason` of the stored decline, so a reader of the data can tell it from a model reply. */
export const EXAM_GUARD_STOP = 'exam_guard'

/** An exam the student is taking: its id and the texts of its questions. */
export type OpenExam = { examId: string; texts: string[] }

/**
 * The student's mock exams in progress in this course, with their question texts. An attempt whose time ran out
 * while the student was away is not in progress any more (the next visit to the exam submits it), so it does not count.
 */
export async function openExams(userId: string, projectId: string, now: Date = new Date()): Promise<OpenExam[]> {
  const attempts = await prisma.examSubmission.findMany({
    where: {
      userId,
      status: 'in_progress',
      sampleExam: { projectId },
      OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
    },
    orderBy: { startedAt: 'asc' },
    select: { sampleExamId: true, sampleExam: { select: { questions: true } } },
  })
  return attempts.map((attempt) => ({ examId: attempt.sampleExamId, texts: examQuestionTexts(attempt.sampleExam.questions) }))
}

/**
 * The open exam this message gives away a question of, or undefined. The word check reads the message with the
 * student's last `history` messages; when it passes the message, the AI service's meaning check reads it too, for a
 * question reworded in other words or put into another language. Only runs while an exam is in progress.
 */
export async function guardingExam(
  userId: string,
  projectId: string,
  question: string,
  history: readonly { role: string; content: string }[],
  deps: { exams?: typeof openExams; semantic?: typeof semanticExamMatch } = {}
): Promise<OpenExam | undefined> {
  const exams = await (deps.exams ?? openExams)(userId, projectId)
  if (exams.length === 0) return undefined
  // A declined message is stored as a note, which is nothing the student wrote.
  const recent = history.filter((turn) => turn.role === 'user' && turn.content !== EXAM_GUARD_NOTE).map((turn) => turn.content)
  const byWords = exams.find((exam) => examGuard(question, exam.texts, recent))
  if (byWords) return byWords
  for (const exam of exams) {
    if (exam.texts.length > 0 && (await (deps.semantic ?? semanticExamMatch)({ message: question, recent, examTexts: exam.texts }))) return exam
  }
  return undefined
}

/** Every question text of the exams in progress. */
export async function openExamQuestionTexts(userId: string, projectId: string, now: Date = new Date()): Promise<string[]> {
  return (await openExams(userId, projectId, now)).flatMap((exam) => exam.texts)
}

/** Where the exam is taken: the decline links back to it. */
export const examTakeHref = (projectId: string, examId: string) => `/courses/${projectId}/exams/${examId}/take`

/** The reply: the decline, and a link back to the exam when one is known (it is part of the stored text, so a reload keeps it). */
export function declinedReply(backHref?: string | null): string {
  return backHref ? `${EXAM_GUARD_REPLY}\n\n[Back to your mock exam](${backHref})` : EXAM_GUARD_REPLY
}

/** The AI service's stream for a declined question: one finished answer with no sources and no cost. */
export function declinedStream(backHref?: string | null): ReadableStream<Uint8Array> {
  const done = {
    type: 'done',
    text: declinedReply(backHref),
    sources: [],
    marks: [],
    stop_reason: EXAM_GUARD_STOP,
    retrieved: 0,
    usage: { model: '', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(done) + '\n'))
      controller.close()
    },
  })
}
