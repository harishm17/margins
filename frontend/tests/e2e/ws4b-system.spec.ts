import { expect, test } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn } from './helpers/auth'
import { smallTargets } from './helpers/targets'

const course = `/courses/${demoIds().course}`

test('materials: a rejected upload is counted, and the footer does not say it was read', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/materials`, { waitUntil: 'networkidle' })
  await expect(page.getByText('Every file here has been read.')).toBeVisible()

  await page.getByLabel('Choose files to upload').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a study file'),
  })
  await expect(page.getByText('Use a PDF, DOCX, PPTX or DOC file.')).toBeVisible()
  await expect(page.getByText('Every file here has been read.')).toHaveCount(0)
  await expect(page.getByText(/\d+ files? ready; 1 file needs attention\./)).toBeVisible()

  // Removing the rejected row puts the plain sentence back.
  await page.getByRole('button', { name: 'Dismiss notes.txt' }).click()
  await expect(page.getByText('Every file here has been read.')).toBeVisible()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('ask: the network error keeps the question and every control is 44px', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.route('**/api/projects/*/chat', (route) => route.abort())
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
    const composer = page.getByLabel('Ask about your materials')
    await composer.fill('What is hashing?')
    // 16px entry text: iOS does not zoom the page when the field gets focus.
    expect(await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(16)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(400)
    expect(await smallTargets(page)).toEqual([])
  })

  test('entry text is 16px on a phone and 14px on a desktop', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/settings`, { waitUntil: 'networkidle' })
    const input = page.getByLabel('Course name')
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(16)
    await page.setViewportSize({ width: 1440, height: 900 })
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(14)
  })

  test('login: Terms and Privacy Policy sit in one sentence and are 44px to press', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText(/^By continuing you agree to the/)).toContainText('Terms and Privacy Policy')
    // smallTargets counts the 44px hit strip behind an inline link.
    expect(await smallTargets(page)).toEqual([])
  })
})

test('desktop keeps the compact sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page, DEMO_EMAIL)
  await page.goto(course)
  await page.getByRole('button', { name: 'Course actions' }).click()
  const row = await page.getByRole('menuitem', { name: 'Course settings' }).boundingBox()
  expect(row?.height ?? 0).toBeLessThan(40)
})
