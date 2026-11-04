import type { VoiceStyle } from './voice-api'

/**
 * Whether Quiz me can begin, known before Start (the server works it out without a model call): it can when the topic has quiz
 * questions the coach can ask aloud, or notes to write questions from. Otherwise `reason` says which is missing: no quiz at all,
 * or a quiz made only of working that cannot be asked out loud (`total` is how many questions it has).
 */
export type VoiceQuizStatus = { state: 'ready' } | { state: 'missing'; reason: 'no_quiz' | 'not_speakable'; total: number }

export const quizIsMissing = (quiz: VoiceQuizStatus | undefined): quiz is Extract<VoiceQuizStatus, { state: 'missing' }> => quiz?.state === 'missing'

/** Whether the chosen style needs the quiz: Quiz me does, and so does a sprint. Teach it back and Read it with me do not. */
export const styleNeedsQuiz = (mode: 'topic' | 'sprint', style: VoiceStyle) => mode === 'sprint' || style === 'oral_quiz'

/** What the lobby tells the student when Quiz me cannot begin: the title, what exactly is missing, and the way forward. */
export function quizMissingCopy(mode: 'topic' | 'sprint', quiz: Extract<VoiceQuizStatus, { state: 'missing' }>, otherStylesWork: boolean) {
  const others = otherStylesWork ? ' Teach it back and Read it with me work without a quiz.' : ''
  if (quiz.reason === 'not_speakable') {
    return {
      title: "Quiz me can't ask these questions out loud",
      text:
        (mode === 'sprint'
          ? "The quizzes for these topics are made of calculations and working that can't be asked out loud."
          : `This topic's quiz has ${quiz.total === 1 ? '1 question' : `${quiz.total} questions`}, and each one is a calculation or working that can't be asked out loud.`) +
        ` Practice them in the quiz instead.${others}`,
      action: 'Open the quiz',
    }
  }
  return {
    title: 'Quiz me needs a quiz first',
    text:
      (mode === 'sprint' ? 'None of these topics has a quiz yet.' : "This topic doesn't have a quiz yet, so there are no questions to ask.") +
      ` Write one, then come back.${others}`,
    action: mode === 'sprint' ? 'Go to topics' : 'Write the quiz',
  }
}
