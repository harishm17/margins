import type { VoiceStyle } from './voice-api'

/**
 * The style the lobby begins on: the one the link names, unless what that style needs is missing (the claims of the idea or topic
 * from the student's pages), when only Quiz me can run.
 */
export function startingStyleFor(hasClaims: boolean, initialStyle: VoiceStyle | undefined): VoiceStyle {
  return hasClaims ? (initialStyle ?? 'oral_quiz') : 'oral_quiz'
}
