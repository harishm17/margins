import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn } from './helpers/loop'
import { smallTargets } from './helpers/targets'

// The phone hit-target contract: below the sm breakpoint every control a finger can press is at least
// 44px, and keeps its compact size on a desktop (shared primitives in components/ui, class strings in
// components/ui/styles.ts). This lists anything under 44px on the shell, the menus and the public pages.
// The topic study views and the exam screens are checked by their own specs.
test.use({ viewport: { width: 390, height: 844 } })

const { course } = demoIds()

async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  // The theme and popup transitions are 120ms; measure after them.
  await page.waitForTimeout(400)
}

async function expectBig(page: Page, what: string) {
  await settle(page)
  expect(await smallTargets(page), `${what}: controls under 44px`).toEqual([])
}

test.describe('public pages', () => {
  for (const url of ['/', '/login', '/privacy', '/terms', '/evaluation', '/account-deleted']) {
    test(`${url} has no control under 44px`, async ({ page }) => {
      await page.goto(url)
      await expectBig(page, url)
    })
  }

  test('the theme menu rows are 44px', async ({ page }) => {
    await page.goto('/privacy')
    await page.getByRole('button', { name: 'Theme' }).click()
    await expectBig(page, 'theme menu')
  })
})

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
  })

  for (const [name, path] of [
    ['home', '/home'],
    ['course overview', `/courses/${course}`],
    ['topics list', `/courses/${course}/topics`],
    ['materials', `/courses/${course}/materials`],
    ['ask', `/courses/${course}/ask`],
    ['settings', '/settings'],
    ['course settings', `/courses/${course}/settings`],
  ] as const) {
    test(`${name} has no control under 44px`, async ({ page }) => {
      await page.goto(path)
      await expectBig(page, name)
    })
  }

  test('the ask scope select opens 44px options', async ({ page }) => {
    await page.goto(`/courses/${course}/ask`)
    await page.getByRole('combobox', { name: 'Ask about' }).click()
    await expectBig(page, 'ask scope list')
  })

  test('the course actions menu rows are 44px', async ({ page }) => {
    await page.goto(`/courses/${course}`)
    await page.getByRole('button', { name: 'Course actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Course settings' })).toBeVisible()
    await expectBig(page, 'course actions menu')
  })

  test('the account menu rows and theme tiles are 44px', async ({ page }) => {
    await page.goto('/home')
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('button', { name: /account menu/ }).click()
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
    await expectBig(page, 'account menu')
    const tile = await page.getByRole('menuitemradio', { name: 'Light', exact: true }).boundingBox()
    expect(tile?.height ?? 0, 'theme tiles keep their size').toBeGreaterThanOrEqual(56)
  })

  test('the search dialog rows are 44px', async ({ page }) => {
    await page.goto(`/courses/${course}`)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Search and commands' })).toBeVisible()
    await expectBig(page, 'search dialog')
  })
})
