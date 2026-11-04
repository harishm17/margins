import type { VoiceStyle } from './voice-api'

/**
 * The style the lobby begins on: the one the link names, unless what that style needs is missing (the claims of the idea or topic
 * from the student's pages), when only Quiz me can run.
 */
export function startingStyleFor(hasClaims: boolean, initialStyle: VoiceStyle | undefined, quizMissing = false): VoiceStyle {
  if (!hasClaims) return 'oral_quiz'
  // No quiz to ask from and nothing named: begin on the style that can run.
  return initialStyle ?? (quizMissing ? 'teach_back' : 'oral_quiz')
}
