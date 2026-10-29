/**
 * Links to sections of the landing page ("How it works", "Sources", "FAQ"). Each is a real link to
 * `/#id`, so it works without JavaScript, in a new tab and when shared. On the landing page a plain
 * click scrolls to the section instead and moves focus to its heading, without writing `#id` into
 * the address bar or the history. From another page the link navigates, and the landing page then
 * scrolls to the section and takes the hash off the URL (`arriveAtSection`).
 */

export const SECTION_IDS = ['how-it-works', 'trust', 'faq'] as const
export type SectionId = (typeof SECTION_IDS)[number]

export const LANDING_PATH = '/'

export const sectionHref = (id: SectionId): string => `${LANDING_PATH}#${id}`

/** The parts of a click event the decision needs (a React or a DOM mouse event both fit). */
export type ClickLike = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * Whether a click on a section link should scroll within the page instead of following the link:
 * only on the landing page, only a plain primary click. A middle click, or one with Cmd, Ctrl, Shift
 * or Alt, keeps the browser's meaning (new tab, new window, download), and so does a link that opens
 * in another browsing context.
 */
export function shouldScrollInPage(click: ClickLike, where: { pathname: string | null; target?: string | null }): boolean {
  if (click.defaultPrevented) return false
  if (click.button !== 0) return false
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false
  if (where.target && where.target !== '_self') return false
  return where.pathname === LANDING_PATH
}

/**
 * The section a URL hash points to (`#faq`), or null when it isn't one of them. The hash comes from
 * the address bar, so anything goes: one that doesn't decode (`#50%`) is ignored, never thrown.
 */
export function sectionFromHash(hash: string): SectionId | null {
  let id: string
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''))
  } catch {
    return null
  }
  return (SECTION_IDS as readonly string[]).includes(id) ? (id as SectionId) : null
}

/** What scrolling needs from the page; `document` and `window` in the browser, fakes in tests. */
export type ScrollEnv = {
  getElementById: (id: string) => ScrollTarget | null
  prefersReducedMotion: () => boolean
}
export type ScrollTarget = {
  scrollIntoView: (options: ScrollIntoViewOptions) => void
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null
}

export const browserScrollEnv = (): ScrollEnv => ({
  getElementById: (id) => document.getElementById(id),
  prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
})

/**
 * Scrolls the section into view (smoothly, or at once when the system asks for less motion) and moves
 * focus to its heading, without scrolling a second time, so keyboard and screen reader users carry on
 * from the section they chose. The heading is the section's `[data-section-heading]` (with
 * tabIndex -1). The section's `scroll-margin-top` sets the gap above it. Returns false when the
 * section is not on this page.
 */
export function scrollToSection(id: SectionId, env: ScrollEnv, options: { instant?: boolean } = {}): boolean {
  const section = env.getElementById(id)
  if (!section) return false
  const behavior: ScrollBehavior = options.instant || env.prefersReducedMotion() ? 'auto' : 'smooth'
  section.scrollIntoView({ behavior, block: 'start' })
  section.querySelector('[data-section-heading]')?.focus({ preventScroll: true })
  return true
}
