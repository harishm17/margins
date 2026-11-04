import { expect, test } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn } from './helpers/loop'
import { smallInteractiveText } from './helpers/type-floor'

// The phone type floor (cross-app rule): the scale stays 14 / 13 / 12, but copy a student acts on is not set under 13px on a
// phone. This lists any button, link, tab or label text under 13px on the screens below, so a new 12px label shows up here.
test.use({ viewport: { width: 390, height: 844 } })

const { course } = demoIds()

const PAGES = ['/', '/login', '/privacy', '/terms', '/evaluation']
const COURSE_PAGES = ['/ask', '/review', '/map', '/exams', '/materials', '/settings']
// Pages whose files belong to other workstreams of round 4 (Overview and Plan: W3, Topics list: W3). They are reported, not failed,
// until their owners have moved the labels listed in the report to 13px; then move the path into COURSE_PAGES.
const REPORTED_ONLY = ['', '/plan', '/topics']

async function settle(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
}

test.describe('public pages', () => {
  for (const url of PAGES) {
    test(`${url} has no interactive text under 13px`, async ({ page }) => {
      await page.goto(url)
      await settle(page)
      expect(await smallInteractiveText(page), `${url}: interactive text under 13px`).toEqual([])
    })
  }
})

test.describe('signed in', () => {
  for (const path of COURSE_PAGES) {
    test(`course${path || ' overview'} has no interactive text under 13px`, async ({ page }) => {
      await signIn(page, DEMO_EMAIL)
      await page.goto(`/courses/${course}${path}`)
      await settle(page)
      expect(await smallInteractiveText(page), `${path}: interactive text under 13px`).toEqual([])
    })
  }

  for (const path of REPORTED_ONLY) {
    test(`course${path || ' overview'}: report of interactive text under 13px`, async ({ page }) => {
      await signIn(page, DEMO_EMAIL)
      await page.goto(`/courses/${course}${path}`)
      await settle(page)
      const found = await smallInteractiveText(page)
      test.info().annotations.push({ type: 'under 13px', description: found.join('; ') || 'none' })
    })
  }

  test('the More sheet and the Courses and account sheet have none either', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`)
    await settle(page)
    await page.getByRole('button', { name: 'More' }).click()
    expect(await smallInteractiveText(page), 'More sheet').toEqual([])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open menu' }).click()
    expect(await smallInteractiveText(page), 'Courses and account sheet').toEqual([])
  })
})
