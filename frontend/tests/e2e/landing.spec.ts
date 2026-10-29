import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Account' })

test('the landing page tells the loop from files to exam day', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1, name: 'Your course files, planned to exam day.' })).toBeVisible()
  await expect(nav(page).getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/login')
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  await expect(page.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '#how-it-works')

  // The hero shows the plan, and it is the current app (Plan and Review in the navigation).
  await expect(page.getByRole('img', { name: /The Margins plan page/ })).toBeVisible()

  // Sections in order, each with its heading.
  for (const name of ['From your files to exam day', 'Sources you can check', 'Common questions', 'Start with one course.']) {
    await page.getByRole('heading', { level: 2, name }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }

  // The loop: six steps, one screenshot beside them, arrow keys move between steps.
  const tabs = page.getByRole('tablist', { name: 'From your files to exam day' }).getByRole('tab')
  await expect(tabs).toHaveCount(6)
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await tabs.first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('tab', { name: 'Check the course plan' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Check the course plan' }).getByRole('img', { name: /topic editor/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Sit mocks that match your exams' }).click()
  await expect(page.getByRole('tablist').getByText('follow the wording, task verbs and answer length')).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Sit mocks that match your exams' }).getByRole('img')).toBeVisible()

  // Trust: claims with their links.
  await expect(page.getByRole('link', { name: /Read the evaluation/ })).toHaveAttribute('href', /evals\/results\/2026-10-21-structure\.md$/)
  await expect(page.getByRole('link', { name: /View the code on GitHub/ })).toHaveAttribute('href', 'https://github.com/harishm17/margins')
  await expect(page.getByText('it scored correctness 4.88 out of 5 and grounding in the source pages 4.91')).toBeVisible()
  // The judge is the same model as the writer, and the automatic checks that failed are shown next to the scores.
  await expect(page.getByText('The judge is Claude Opus, the same model that writes the text')).toBeVisible()
  await expect(page.getByText('0 of 8 notes had all the expected sections, and 0 of 8 stayed within the requested length')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Read the privacy policy' })).toHaveAttribute('href', '/privacy')

  // The questions: the first is open, the free answer says what is true, and opening another closes it.
  await expect(page.getByText('Yes. Margins is free to use, with no paid plan and no card.')).toBeVisible()
  await expect(page.getByText('daily AI allowance', { exact: false }).first()).toBeVisible()
  await page.getByText('Which files can I upload?').click()
  await expect(page.getByText('scanned pages are not read yet')).toBeVisible()
  await expect(page.getByText('Yes. Margins is free to use, with no paid plan and no card.')).toBeHidden()

  // Every visible screenshot has loaded and has alt text, and nothing overflows the page sideways.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  })
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.images)
          .filter((image) => image.offsetParent !== null)
          .every((image) => image.complete && image.naturalWidth > 0 && image.alt.length > 10)
      )
    )
    .toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])

  // Structured data (one graph: the site, the organisation, its author, the app, its code and the questions) and the canonical link are present.
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://studymargins.com')
  expect(await page.locator('script[type="application/ld+json"]').count()).toBe(1)
  const types = await page.evaluate(() =>
    (JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')['@graph'] ?? []).map((item: { '@type': string }) => item['@type'])
  )
  expect(types).toEqual(['WebSite', 'Organization', 'Person', 'SoftwareApplication', 'SoftwareSourceCode', 'FAQPage'])
})

test('on a phone every step shows its own phone-sized screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('tablist')).toBeHidden()
  const steps = page.locator('#how-it-works ol > li')
  await expect(steps).toHaveCount(6)
  await steps.nth(2).scrollIntoViewIfNeeded()
  const image = steps.nth(2).locator('img:visible')
  await expect(image).toHaveCount(1)
  // The phone picture is used (390 px page, 2x), and it is shown near its natural size, not shrunk to a thumbnail.
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
  const shown = await image.evaluate((node: HTMLImageElement) => node.getBoundingClientRect().width)
  const natural = await image.evaluate((node: HTMLImageElement) => node.naturalWidth)
  expect(await image.evaluate((node: HTMLImageElement) => decodeURIComponent(node.currentSrc))).toContain('-mobile-')
  expect(shown / (natural / 2)).toBeGreaterThan(0.8)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('the theme can be switched on the public pages', async ({ page }) => {
  for (const url of ['/', '/login', '/privacy']) {
    await page.goto(url)
    await page.getByRole('button', { name: 'Theme' }).click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.getByRole('button', { name: 'Theme' }).click()
    await page.getByRole('menuitemradio', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  }
})

test('a signed-in visitor sees Open Margins instead of sign in', async ({ page }) => {
  const stamp = Date.now()
  const email = `landing-${stamp}@example.com`

  await signIn(page, email)

  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(nav(page).getByRole('link', { name: 'Open Margins' })).toHaveAttribute('href', '/home')
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open Margins' }).first()).toBeVisible()
})

test('the auth pages show the whole plan screen, not a crop of it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const url of ['/login']) {
    await page.goto(url)
    const image = page.getByRole('complementary').getByRole('img')
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    const [panel, shot] = await Promise.all([page.getByRole('complementary').boundingBox(), image.boundingBox()])
    // Inside the panel on every side, shown at its own proportions.
    expect(shot!.x).toBeGreaterThanOrEqual(panel!.x)
    expect(shot!.x + shot!.width).toBeLessThanOrEqual(panel!.x + panel!.width)
    expect(shot!.y + shot!.height).toBeLessThanOrEqual(panel!.y + panel!.height)
    const natural = await image.evaluate((node: HTMLImageElement) => node.naturalWidth / node.naturalHeight)
    expect(Math.abs(shot!.width / shot!.height - natural)).toBeLessThan(0.02)
  }
})

test('on a phone the sign-in page starts at the top, with the Google button above the fold', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/login')
  const box = await page.getByRole('button', { name: 'Continue with Google' }).boundingBox()
  expect(box!.y + box!.height).toBeLessThan(844)
})
