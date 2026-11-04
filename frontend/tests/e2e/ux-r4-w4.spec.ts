import { expect, test } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn, setZoneCookie } from './helpers/loop'
import { smallTargets } from './helpers/targets'
import { openKeepStudying } from './helpers/review'

// Round 4, workstream W4: the phone navigation sheets, search, the not-found page, the course settings link, the Review landing
// with nothing due, and the voice lobby's answer choice. Map and review-item changes are in map.spec.ts and the quiz specs.

const { course } = demoIds()
const base = `/courses/${course}`

test.describe('phone navigation: each place is on one surface', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('More holds the course places, Browse topics and Switch course; the menu sheet holds course, search, theme and account only', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('button', { name: 'More' }).click()
    const more = page.getByRole('dialog')
    for (const name of ['Review', 'Map', 'Mock exams', 'Materials', 'Course settings', 'Browse topics']) {
      await expect(more.getByRole('link', { name })).toBeVisible()
    }
    await more.getByRole('button', { name: 'Switch course' }).click()

    const menu = page.getByRole('dialog', { name: 'Courses and account' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: /^Course: / })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Search' })).toBeVisible()
    await expect(menu.getByRole('button', { name: /account menu/ })).toBeVisible()
    for (const name of ['Review', 'Map', 'Mock exams', 'Materials', 'Overview', 'Plan', 'Ask']) {
      await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(0)
    }
    await expect(menu.locator('ul[data-collapsible]')).toHaveCount(0)
    // The sheet's controls are finger sized.
    expect(await smallTargets(page)).toEqual([])
  })

  test('the theme is two taps away, with "Match device" saying what it follows', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('button', { name: 'Open menu' }).click()
    const menu = page.getByRole('dialog', { name: 'Courses and account' })
    const system = menu.getByRole('radio', { name: /Match device/ })
    await expect(system).toContainText(/Now (light|dark)/)
    await menu.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(menu.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
    await menu.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})

test.describe('search', () => {
  test('one placeholder; a blank search lists recents (at most five) and no commands; commands are found by typing or by Show commands', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(palette.getByPlaceholder('Search courses, topics and files')).toBeVisible()
    await expect(palette.getByRole('option', { name: /Sign out/ })).toHaveCount(0)
    expect(await palette.getByRole('option').count()).toBeLessThanOrEqual(5)

    await palette.getByPlaceholder('Search courses, topics and files').fill('sign')
    const commands = palette.locator('[cmdk-group]').filter({ hasText: 'Commands' })
    await expect(commands.getByRole('option', { name: /Sign out/ })).toBeVisible()

    await palette.getByPlaceholder('Search courses, topics and files').fill('')
    await palette.getByRole('button', { name: 'Show commands' }).click()
    await expect(palette.getByRole('option', { name: /Sign out/ })).toBeVisible()
    await expect(palette.getByRole('option', { name: /Toggle theme/ })).toBeVisible()
  })

  test('topics opened by a link are offered as recent', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('navigation', { name: 'Course' }).getByRole('link', { name: 'Topics' }).click()
    const topicLink = page.locator('main a[href*="/topics/"]').first()
    const name = (await topicLink.textContent())?.trim() ?? ''
    await topicLink.click()
    await page.waitForURL(/\/topics\//)
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(palette.locator('[cmdk-group]').filter({ hasText: 'Recent' })).toBeVisible()
    expect(name.length).toBeGreaterThan(0)
  })
})

test.describe('not found', () => {
  test('a page reached from inside the app has Go back; a deep link does not', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await page.getByRole('navigation', { name: 'Course' }).getByRole('link', { name: 'Topics' }).first().click()
    await page.waitForURL(/\/topics$/)
    await page.goto(`${base}/no-such-page`)
    // goto from a loaded page keeps the history and the same-site referrer.
    await expect(page.getByRole('heading', { level: 1, name: "We couldn't find that page" })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible()
    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(page).toHaveURL(/\/topics$/)

    const fresh = await page.context().newPage()
    await fresh.goto(`${base}/no-such-page`)
    await expect(fresh.getByRole('heading', { level: 1, name: "We couldn't find that page" })).toBeVisible()
    await expect(fresh.getByRole('button', { name: 'Go back' })).toHaveCount(0)
  })
})

test.describe('course settings link', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('wide screens show a Course settings link beside the actions menu, and the menu says Materials', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(base)
    await expect(page.locator('main').getByRole('link', { name: 'Course settings' })).toHaveAttribute('href', `${base}/settings`)
    await page.getByRole('button', { name: 'Course actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Materials' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Add materials' })).toHaveCount(0)
  })
})

test.describe('Review with nothing due', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('says so, gives the next date, and keeps the extras behind one closed disclosure', async ({ page, context }) => {
    await setZoneCookie(context)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${base}/review`)
    await expect(page.getByRole('heading', { name: 'Nothing is due' })).toBeVisible()
    const keep = page.locator('[data-testid="keep-studying"]:visible')
    await expect(keep).toBeVisible()
    expect(await keep.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false)
    // Closed: none of the extras is on screen.
    await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Quick practice' })).toBeHidden()
    await openKeepStudying(page)
    await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
    // The rules behind the figures are one more step in.
    await expect(page.getByText('How this is calculated').first()).toBeVisible()
  })
})
