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
