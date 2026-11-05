import type { Page } from '@playwright/test'

/**
 * The "New questions" button of a quiz's results. It leads when nothing else does (no first missed idea to go back to, no harder set);
 * otherwise it is one of the quieter choices behind "Other ways to study", which this opens when it is closed.
 */
export async function newQuestionsButton(page: Page) {
  const button = page.getByRole('button', { name: 'New questions' })
  if (await button.isVisible()) return button
  const others = page.getByTestId('other-ways')
  if ((await others.getAttribute('aria-expanded')) === 'false') await others.click()
  return button
}
