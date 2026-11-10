import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { animationsSettled, framesPainted } from './settle'

type AxeResult = { violations: { id: string; nodes: { html: string }[] }[] }

/**
 * A toast fades in and, a few seconds later, out; its colours are not final in either fade, and axe reads the mid-fade
 * colours as a contrast failure. So axe is run when every toast on the page is fully shown, or gone from the page (one on its
 * way out is waited for until it has left: a toast that a background job raises at an unpredictable moment must not decide
 * the result).
 */
async function waitForToastsToSettle(page: Page) {
  const settled = () =>
    [...document.querySelectorAll('[data-sonner-toast]')].every((toast) => {
      const leaving = toast.getAttribute('data-removed') === 'true' || toast.getAttribute('data-visible') === 'false'
      return !leaving && toast.getAttribute('data-mounted') === 'true' && getComputedStyle(toast).opacity === '1'
    })
  try {
    await page.waitForFunction(settled, undefined, { timeout: 10_000 })
  } catch (error) {
    throw new Error('A toast did not finish appearing or leaving within 10 s, so its colours cannot be checked yet', { cause: error })
  }
}

async function runAxe(page: Page): Promise<string[]> {
  await page.evaluate(readFileSync(require.resolve('axe-core'), 'utf8'))
  return page.evaluate(async () => {
    // label-content-name-mismatch is an experimental rule (off by default): a link or button named differently from what it shows is a real failure for voice control.
    const result: AxeResult = await (window as unknown as { axe: { run: (context: Document, options: object) => Promise<AxeResult> } }).axe.run(document, {
      rules: { 'label-content-name-mismatch': { enabled: true } },
    })
    const found = result.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.html.slice(0, 120)).join(' | '))
    // axe lets a closed control point at nothing; a screen reader is told of a panel that is not there, so every id a control names must exist.
    const dangling = [...document.querySelectorAll('[aria-controls]')].filter((element) =>
      (element.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean).some((id) => !document.getElementById(id))
    )
    if (dangling.length > 0) found.push('aria-controls-target: ' + dangling.map((element) => element.outerHTML.slice(0, 120)).join(' | '))
    return found
  })
}

/**
 * Every finite CSS transition and animation has ended. A button fades its background over 120 ms when the pointer
 * comes to rest on it, as it does after a viewport resize moves the layout under the pointer; axe reads the mid-fade
 * colour as a contrast failure (map.spec.ts "leads with reading", 390x844, failed this way on main, 2026-11-10).
 * page.waitForFunction rather than settle.ts's expect.poll, since the workflow harness calls this outside a test.
 */
async function waitForTransitionsToEnd(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((animation) => !(animation.playState === 'running' || animation.pending) || animation.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 10_000 }
  )
}

async function settle(page: Page) {
  await waitForToastsToSettle(page)
  await waitForTransitionsToEnd(page)
}

export async function axeViolations(page: Page): Promise<string[]> {
  await settle(page)
  const violations = await runAxe(page)
  if (violations.length === 0) return violations
  // A toast can start to leave while axe is reading the page (it is on screen for four seconds): a finding is looked at
  // again once the toasts and transitions have settled, and counts only if it is still there.
  await settle(page)
  return runAxe(page)
}

/**
 * Runs axe-core on the page as it is now and expects no violations (the rule id and the first nodes name any).
 * The page's title streams in and is rewritten while the app navigates, so a run that finds only a missing
 * document title waits for one and looks again; any other violation counts at once.
 */
export async function expectNoAxeViolations(page: Page, label: string) {
  await page.waitForFunction(() => document.title.trim() !== '')
  let violations = await axeViolations(page)
  for (let attempt = 0; attempt < 6 && violations.length > 0 && violations.every((v) => v.startsWith('document-title')); attempt++) {
    // The title is written as the page streams in; the next look is taken once a frame has been drawn with it.
    await page.waitForFunction(() => document.title.trim() !== '')
    await framesPainted(page)
    violations = await axeViolations(page)
  }
  expect(violations, label).toEqual([])
}

/**
 * A screenshot into SCREENS_DIR when it is set, for a look at the page by eye: the full page, or only the
 * viewport when SCREENS_VIEWPORT is set (fixed bars then do not overlay the content).
 */
export async function screenshotIfAsked(page: Page, name: string) {
  const dir = process.env.SCREENS_DIR
  if (!dir) return
  const fullPage = !process.env.SCREENS_VIEWPORT
  const shoot = async (file: string) => {
    // The browser now and then cannot capture a frame right after a transition: wait and take it once more.
    try {
      await page.screenshot({ path: file, fullPage })
    } catch {
      await animationsSettled(page)
      await framesPainted(page)
      await page.screenshot({ path: file, fullPage })
    }
  }
  // Viewport shots are of the top of the page (what a student sees on arriving); when the page was scrolled, the
  // view as it was is kept too, as `-scrolled`.
  // A page that is still redirecting has no scroll to read yet: let it settle first.
  if (!fullPage) await page.waitForLoadState('load')
  const scrolled = fullPage ? 0 : await page.evaluate(() => window.scrollY).catch(() => 0)
  if (scrolled > 0) {
    await shoot(`${dir}/${name}-scrolled.png`)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await framesPainted(page)
  }
  await shoot(`${dir}/${name}.png`)
  if (scrolled > 0) await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrolled)
  // SCREENS_BOTH: a surface a spec shoots at one size is shot at the other size too, from the same state.
  const sizes: Record<string, { width: number; height: number }> = { '1440x900': { width: 1440, height: 900 }, '390x844': { width: 390, height: 844 } }
  const current = Object.keys(sizes).find((size) => name.includes(size))
  if (process.env.SCREENS_BOTH && current) {
    const other = current === '1440x900' ? '390x844' : '1440x900'
    const original = page.viewportSize()
    await page.setViewportSize(sizes[other])
    await page.waitForFunction((width) => window.innerWidth === width, sizes[other].width)
    await animationsSettled(page)
    if (!fullPage) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await framesPainted(page)
    }
    await shoot(`${dir}/${name.replace(current, other)}.png`)
    if (original) {
      await page.setViewportSize(original)
      await page.waitForFunction((width) => window.innerWidth === width, original.width)
      await animationsSettled(page)
    }
  }
}
