import { expect, type Page } from '@playwright/test'

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
