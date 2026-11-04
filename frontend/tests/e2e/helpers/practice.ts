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
