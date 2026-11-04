import type { Locator, Page } from '@playwright/test'

/**
 * Taps a level of the optional confidence row ("How sure are you?"). On a phone the row is one folded line ("Confidence (optional)") that
 * opens the choices, so it is opened first when the choices are not on screen; on a wide screen they always are.
 */
export async function chooseConfidence(scope: Page | Locator, name: string) {
  const radio = scope.getByRole('radio', { name, exact: true })
  if (!(await radio.isVisible())) await scope.getByRole('button', { name: /^Confidence/ }).click()
  await radio.click()
}
