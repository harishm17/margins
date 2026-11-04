import type { Page } from '@playwright/test'

/**
 * With nothing due the Review page keeps its extras (quick practice, voice practice, progress) behind a closed "Keep
 * studying (optional)" disclosure. Opens it when the page has one; a page with work due has none and is left as it is.
 */
export async function openKeepStudying(page: Page) {
  // While the page streams in, a hidden copy of it waits in the document: only the one on screen counts.
  const box = page.locator('[data-testid="keep-studying"]:visible')
  if ((await box.count()) === 0) return
  if (await box.evaluate((element) => (element as HTMLDetailsElement).open)) return
  await box.locator('summary').first().click()
}
