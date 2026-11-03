import { expect, type Page } from '@playwright/test'

/**
 * Resolves once nothing on the page is mid-way through a CSS transition or animation: every one that will end has
 * ended (a spinner that loops for ever is not waited for). Use it instead of a fixed sleep after something that moves.
 */
export async function animationsSettled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().iterations !== Infinity).length
      )
    )
    .toBe(0)
}

/** Two painted frames have passed: layout that changed a moment ago (a resize, a scroll) has been drawn. */
export async function framesPainted(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/**
 * The page's streamed parts have all arrived. Until then a hidden copy of each waits in the document, and a locator that
 * matches text finds both (a strict-mode violation, or a count that is twice what it should be).
 */
export async function streamedPartsArrived(page: Page) {
  await page.waitForFunction(() => document.querySelector('[id^="S:"]') === null)
}
