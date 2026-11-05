import { expect, type Locator, type Page } from '@playwright/test'

/** The elements that stick out past the right edge, for the failure message. */
export const overflowing = (page: Page) =>
  page.evaluate(() => {
    const width = window.innerWidth
    // Something inside a box that scrolls or clips on its own does not widen the page.
    const clipped = (element: Element) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== 'visible') return true
      }
      return false
    }
    return [...document.querySelectorAll('body *')]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ element, box }) => box.width > 0 && box.right > width + 0.5 && !clipped(element))
      .slice(0, 8)
      .map(({ element, box }) => {
        const classes = typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 4).join('.') : ''
        return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''} right=${Math.round(box.right)}`
      })
  })

export async function expectNoSidewaysScroll(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, `${url} is ${scrollWidth}px wide in a ${innerWidth}px window; sticking out: ${(await overflowing(page)).join(', ')}`).toBeLessThanOrEqual(
    innerWidth
  )
}

/**
 * A primary action is not under the fixed bottom tab bar (phones): once it has focus, which scrolls it into
 * view, its bottom edge is above the bar's top edge.
 */
export async function expectClearOfTabBar(page: Page, action: Locator, label: string) {
  // Focus scrolls the element into view, honouring the page's scroll padding; blur first so a focused one scrolls too.
  await action.evaluate((element) => (element as HTMLElement).blur())
  await action.focus()
  const gap = async () => {
    const tabs = page.getByRole('navigation', { name: 'Course tabs' })
    // boundingBox() waits for an element that is not there, so look first.
    const bar = (await tabs.count()) > 0 ? await tabs.boundingBox() : null
    const box = await action.boundingBox()
    expect(box, `${label} is on screen`).not.toBeNull()
    // During a study attempt the phone shell hides the tab bar (useShellAttempt), so the window's foot is the limit then.
    const limit = bar ? bar.y : (page.viewportSize()?.height ?? 0)
    // Positive when the action ends above the bar. The scroll the focus caused may still be under way, so this is polled.
    return Math.round(limit - (box!.y + box!.height))
  }
  await expect.poll(gap, { message: `${label} ends above the tab bar` }).toBeGreaterThanOrEqual(0)
}
