/**
 * What the one-time effort card remembers in this browser tab, per user: a second user who signs in in the
 * same tab still sees their own card. The server (User.seenEffortIntroAt) is the record that lasts.
 */

const closedFor = new Set<string>()

export const isCardClosed = (userId: string): boolean => closedFor.has(userId)
export const markCardClosed = (userId: string): void => void closedFor.add(userId)
export const markCardOpen = (userId: string): void => void closedFor.delete(userId)

/** Saves that the card was closed; one retry after a failure. True when the server has it. */
export async function saveCardClosed(save: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await save()
      return true
    } catch {
      // Try once more, then give up.
    }
  }
  return false
}

export const subscribeNever = () => () => {}

const seenKey = (userId: string) => 'margins.effortIntroSeen.' + userId
const seenAtLoad = new Map<string, boolean>()

/** The card was already shown on an earlier page load in this browser (decided once per page load, so its first view stays whole). */
export function cardSeenBefore(userId: string): boolean {
  if (!seenAtLoad.has(userId)) {
    try {
      seenAtLoad.set(userId, window.localStorage.getItem(seenKey(userId)) !== null)
    } catch {
      seenAtLoad.set(userId, false)
    }
  }
  return seenAtLoad.get(userId) ?? false
}

/** Notes that the card has been shown, for the next page load. */
export function rememberCardSeen(userId: string): void {
  try {
    window.localStorage.setItem(seenKey(userId), '1')
  } catch {
    // Private mode: the card is whole every time, which is harmless.
  }
}
