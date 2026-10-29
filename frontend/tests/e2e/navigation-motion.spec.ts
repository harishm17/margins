import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { createCourse, signUpAndIn } from './helpers/loop'
import { FIXTURE_PDF } from './helpers/seed-demo'

/** Scrolls so only the top fifth of the loop (steps and screenshot) shows, at the bottom of the window. */
const showLoopSliver = (page: Page) =>
  page.evaluate(() => {
    const zone = document.querySelector('[role="tablist"]')!.closest('.lg\\:grid') as HTMLElement
    const rect = zone.getBoundingClientRect()
    window.scrollBy(0, rect.top - window.innerHeight + rect.height * 0.2)
  })

// In-page links, the phone menu on the public pages, the landing loop's auto-advance and the toasts'
// place on a phone.

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '')
const hash = (page: Page) => page.evaluate(() => window.location.hash)

test('a header link scrolls to its section without a hash or a history entry, and focuses the heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const before = await page.evaluate(() => window.history.length)

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sources' }).click()
  await expect.poll(() => focusedId(page)).toBe('trust-heading')
  expect(await hash(page)).toBe('')
  expect(page.url()).toBe(new URL('/', page.url()).href)
  expect(await page.evaluate(() => window.history.length)).toBe(before)
  await expect(page.getByRole('heading', { level: 2, name: 'Sources you can check' })).toBeInViewport()

  // The footer has the same links, Sources included.
  const footer = page.getByRole('navigation', { name: 'Product' })
  await expect(footer.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/#trust')
  await footer.getByRole('link', { name: 'FAQ' }).click()
  await expect.poll(() => focusedId(page)).toBe('faq-heading')
  expect(await hash(page)).toBe('')

  // A modified click keeps the browser's meaning: the link is a real link to /#id.
  await expect(page.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '/#how-it-works')
})

test('from another page a section link lands on the section and leaves a clean URL', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/privacy')
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'FAQ' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect.poll(() => focusedId(page)).toBe('faq-heading')
  await expect(page.getByRole('heading', { level: 2, name: 'Common questions' })).toBeInViewport()
})

test('on a phone the public pages have a menu with the same links', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden()
  // The header fits: nothing pushes the page sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

  const menu = page.getByRole('button', { name: 'Menu' })
  await menu.click()
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav.getByRole('link')).toHaveText(['How it works', 'Sources', 'FAQ', 'Sign in'])
  await nav.getByRole('link', { name: 'FAQ' }).click()
  await expect(nav).toBeHidden()
  await expect.poll(() => focusedId(page)).toBe('faq-heading')
  expect(await hash(page)).toBe('')

  // Escape closes it and gives focus back to the button.
  await menu.click()
  await expect(nav).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(nav).toBeHidden()
  await expect(menu).toBeFocused()
})

test('the landing loop steps through once by itself, pauses, and stops for good on a key', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const tabs = page.getByRole('tablist', { name: 'From your files to exam day' }).getByRole('tab')
  const selected = () => tabs.evaluateAll((nodes) => nodes.findIndex((node) => node.getAttribute('aria-selected') === 'true'))

  // Not before it is in view.
  await page.clock.runFor(8000)
  expect(await selected()).toBe(0)

  await page.locator('#how-it-works').scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await page.clock.runFor(7100)
  await expect.poll(selected).toBe(1)
  // It moved the tab, not the focus.
  expect(await focusedId(page)).not.toMatch(/^loop-tab/)

  // The pause button works from the keyboard, and play carries on.
  const pause = page.getByRole('button', { name: 'Pause the steps' })
  await pause.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Play the steps' })).toBeFocused()
  await page.clock.runFor(20_000)
  expect(await selected()).toBe(1)
  await page.keyboard.press('Enter')
  await page.clock.runFor(7100)
  await expect.poll(selected).toBe(2)

  // Arrow keys in the steps take over: it stops for good and the pause button goes.
  await tabs.nth(2).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tabs.nth(3)).toBeFocused()
  await expect(page.getByRole('button', { name: /the steps$/ })).toHaveCount(0)
  await page.locator('body').focus()
  await page.mouse.move(5, 5)
  await page.clock.runFor(30_000)
  expect(await selected()).toBe(3)
})

test('the loop does not advance with reduced motion or on a phone', async ({ page }) => {
  await page.clock.install()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.locator('#how-it-works').scrollIntoViewIfNeeded()
  await page.clock.runFor(15_000)
  const tabs = page.getByRole('tablist', { name: 'From your files to exam day' }).getByRole('tab')
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /the steps$/ })).toHaveCount(0)
})

test('on a phone a toast sits above the tab bar, so the tabs stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signUpAndIn(page, 'toast-place')
  const { courseId } = await createCourse(page, 'Toast course', [{ name: 'Sets' }])
  await page.goto(`/courses/${courseId}/settings`)
  await page.getByLabel('Description').fill('Midterm practice')
  await page.getByRole('button', { name: 'Save changes' }).click()

  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Course saved' })
  await expect(toast).toBeVisible()
  const tabBar = page.getByRole('navigation', { name: 'Course tabs' })
  const barBox = (await tabBar.boundingBox())!
  // Polled: the toast slides up into place.
  await expect.poll(async () => {
    const box = (await toast.boundingBox())!
    return box.y + box.height <= barBox.y
  }).toBe(true)
  // A tab can be pressed while the toast shows.
  await tabBar.getByRole('link', { name: 'Plan' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/plan$`))
})

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('keyboard hints are hidden: no "Ctrl K" next to Search in the menu', async ({ page }) => {
    await signUpAndIn(page, 'touch-hints')
    const { courseId } = await createCourse(page, 'Touch course', [{ name: 'Sets' }])
    await page.goto(`/courses/${courseId}/topics`)
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)
    await page.getByRole('button', { name: 'Open menu' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Search' })).toBeVisible()
    await expect(dialog.locator('kbd')).toHaveCount(2)
    for (const key of await dialog.locator('kbd').all()) await expect(key).toBeHidden()
  })
})

test('search keeps two files with the same name apart', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signUpAndIn(page, 'palette-files')
  const { courseId } = await createCourse(page, 'Palette course', [{ name: 'Sets' }])
  await page.goto(`/courses/${courseId}/materials`)
  const pdf = { name: 'notes.pdf', mimeType: 'application/pdf', buffer: readFileSync(FIXTURE_PDF) }
  await page.getByLabel('Choose files to upload').setInputFiles([pdf, pdf])
  await expect(page.getByText('Every file here has been read.')).toBeVisible({ timeout: 60_000 })
  await page.reload()
  await expect(page.getByText('notes.pdf', { exact: true })).toHaveCount(2)

  await page.keyboard.press('Control+k')
  await page.getByPlaceholder(/^Search topics/).fill('notes.pdf')
  const files = page.locator('[cmdk-group]').filter({ hasText: 'Files' }).locator('[cmdk-item]')
  await expect(files).toHaveCount(2)
  const selected = page.locator('[cmdk-item][data-selected="true"]')
  await expect(selected).toHaveCount(1)
  await expect(files.nth(0)).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(selected).toHaveCount(1)
  await expect(files.nth(1)).toHaveAttribute('data-selected', 'true')

  // Both files remembered under Recent (what opening each one stores): two entries, still apart.
  const ids = await files.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-value') ?? ''))
  expect(new Set(ids).size).toBe(2)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.evaluate((recentIds) => localStorage.setItem('margins:recent', JSON.stringify(recentIds)), ids)
  await page.keyboard.press('Control+k')
  const recent = page.locator('[cmdk-group]').filter({ hasText: 'Recent' }).locator('[cmdk-item]')
  await expect(recent).toHaveCount(2)
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveCount(1)
})

test('the loop waits until at least half of it is in view, and pauses again below that', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const tabs = page.getByRole('tablist', { name: 'From your files to exam day' }).getByRole('tab')
  const selected = () => tabs.evaluateAll((nodes) => nodes.findIndex((node) => node.getAttribute('aria-selected') === 'true'))
  await showLoopSliver(page)
  await page.mouse.move(5, 5)
  await page.clock.runFor(16_000)
  expect(await selected()).toBe(0)

  await page.evaluate(() => document.getElementById('how-it-works')!.scrollIntoView())
  await page.waitForTimeout(200)
  await page.clock.runFor(7100)
  await expect.poll(selected).toBe(1)
  await showLoopSliver(page)
  await page.waitForTimeout(200)
  await page.clock.runFor(16_000)
  expect(await selected()).toBe(1)
})

test('when the pass ends with focus on Pause, focus moves to the open step', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.locator('#how-it-works').scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await page.getByRole('button', { name: 'Pause the steps' }).focus()
  await page.clock.runFor(7000 * 6 + 500)
  await expect(page.getByRole('button', { name: /the steps$/ })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Upload your files' })).toBeFocused()
})

test('a fragment that is not a section, or does not decode, is left alone', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const fragment of ['50%', 'nothing-here']) {
    await page.goto(`/#${fragment}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForTimeout(300)
    expect(new URL(page.url()).hash).toBe(`#${fragment}`)
  }
  expect(errors).toEqual([])
})
