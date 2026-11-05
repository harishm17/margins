/**
 * Whether going back would stay in the app: the page was reached from another page of this site (a same-site
 * referrer, or a navigation the app made itself). A deep link opened in a new tab has nowhere to go back to, so
 * the pages show no button then.
 */
export function canGoBackInApp(historyLength: number, referrer: string, origin: string, appHistory: boolean): boolean {
  if (historyLength <= 1) return false
  if (appHistory) return true
  return referrer.startsWith(`${origin}/`)
}
