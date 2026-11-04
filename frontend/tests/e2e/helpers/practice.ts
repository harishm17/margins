import type { Page } from '@playwright/test'

/**
 * The optional working box of a practice step. It is one line ("Your working (optional)") under the answer until it is wanted,
 * so this opens it when it is closed and returns the text box.
 */
export async function workingBox(page: Page) {
  const box = page.getByLabel('Your working (optional)').locator('visible=true')
  if ((await box.count()) === 0) await page.getByRole('button', { name: 'Your working (optional)' }).locator('visible=true').click()
  return box
}

/**
 * Opens the folded help of a practice step ("Get help" before a try, "More help" after a miss) when it is closed. After a miss the
 * way on is Try again and the next hint; everything else (where to look, Show answer, the tutor) is behind this one button.
 */
export async function openMoreHelp(page: Page) {
  const toggle = page.getByRole('button', { name: /^(Get|More) help$/ }).locator('visible=true')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}
