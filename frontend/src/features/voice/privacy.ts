/** What the lobby tells the student about where their voice goes (spec 19.9). Draft copy: the owner finalises it. */
import type { SpeechDestination } from './on-device'

export const PRIVACY_LINES: Record<SpeechDestination, string> = {
  device: 'Your voice is turned into text on this device. It is not sent to a speech service.',
  google: 'Your browser sends your voice to Google to turn it into text.',
  apple: 'Your browser sends your voice to Apple to turn it into text.',
  browser: "Your browser's speech service hears your voice to turn it into text.",
}

/** After the line: how to avoid the service altogether. */
export const PRIVACY_TYPING = 'Typing avoids it.'

/** The lobby's choice of recognizer when Margins offers cloud recognition (spec 19.12). Draft copy. */
export const CLOUD_TOGGLE_LABEL = 'Better speech recognition'
export const CLOUD_TOGGLE_DESCRIPTION = "Catches course terms more reliably. Turn it off to use your browser's own."

const PROVIDER_NAMES: Record<string, string> = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI' }

/**
 * The line when cloud recognition is on, naming the speech services in the order they are used (the second only takes
 * over when the first cannot). Draft copy.
 */
export function cloudPrivacyLine(providers: readonly string[]): string {
  const names = providers.map((provider) => PROVIDER_NAMES[provider] ?? provider)
  if (names.length === 0) return 'Margins sends your voice to a speech service to turn it into text.'
  if (names.length === 1) return `Margins sends your voice to ${names[0]}, a speech service, to turn it into text.`
  return `Margins sends your voice to ${names[0]}, a speech service, to turn it into text (${names.slice(1).join(' or ')} if it is unavailable).`
}
