import type { Locator, Page } from '@playwright/test'

/**
 * Taps a level of the optional "How sure are you?" row. On a phone the row is one folded line ("How sure are you? (optional)") that
 * opens the choices, so it is opened first when the choices are not on screen; on a wide screen they always are.
 */
export async function chooseConfidence(scope: Page | Locator, name: string) {
  const radio = scope.getByRole('radio', { name, exact: true })
  if (!(await radio.isVisible())) await scope.getByRole('button', { name: /^How sure/ }).click()
  await radio.click()
}
