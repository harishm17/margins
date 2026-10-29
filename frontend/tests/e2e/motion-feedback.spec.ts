import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn } from './helpers/loop'

// Motion that is feedback: the study tabs answer a click at once, the quiz and exam questions slide the
// way the student went, the sidebar's unit groups slide open and shut, and nothing of it moves under
// reduced motion. Server answers are held back with a route (no extra latency in the app itself).

const { course, topics } = demoIds()
const topicUrl = `/courses/${course}/topics/${topics[0]}`

/** Holds every page data request (not prefetches) back by `ms`. */
async function slowPages(page: Page, ms: number) {
  await page.route('**/*', async (route) => {
    const headers = route.request().headers()
    if (headers['rsc'] === '1' && !headers['next-router-prefetch']) await new Promise((resolve) => setTimeout(resolve, ms))
    await route.continue()
  })
}

const studyPath = (page: Page) => page.getByRole('navigation', { name: 'Study path' })
const panelOpacity = (page: Page) =>
  page.evaluate(() => +getComputedStyle(document.querySelector('[data-tab-panel]')!).opacity)

/** Watches every frame from now on: when a tab shows pending, and the lowest panel opacity seen. */
const watchTabs = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __tabs: { clickAt: number; pendingAt: number | null; minOpacity: number; stop: boolean } }
    w.__tabs = { clickAt: 0, pendingAt: null, minOpacity: 1, stop: false }
    document.addEventListener('click', () => (w.__tabs.clickAt = performance.now()), { capture: true, once: true })
    const tick = () => {
      const t = w.__tabs
      if (t.clickAt && t.pendingAt === null && document.querySelector('[data-tab-pending]')) t.pendingAt = performance.now()
      t.minOpacity = Math.min(t.minOpacity, +getComputedStyle(document.querySelector('[data-tab-panel]')!).opacity)
      if (!t.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
const tabsReport = (page: Page) =>
  page.evaluate(() => {
    const t = (window as unknown as { __tabs: { clickAt: number; pendingAt: number | null; minOpacity: number; stop: boolean } }).__tabs
    t.stop = true
    return { latency: t.pendingAt === null ? null : t.pendingAt - t.clickAt, minOpacity: t.minOpacity }
  })

test.describe('study tabs', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a click draws the underline at once and the old view dims after a wait, then the new view is whole', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
    await slowPages(page, 800)
    await watchTabs(page)
    const practice = studyPath(page).getByRole('link', { name: /^Practice/ })
    await practice.click()

    // Pending shows within a frame or two; the old tab is still the current one.
    await expect(practice.locator('[data-tab-pending]')).toBeAttached({ timeout: 150 })
    await expect(studyPath(page).getByRole('link', { name: /^Notes/ })).toHaveAttribute('aria-current', 'page')
    expect(await practice.locator('[data-tab-indicator]').evaluate((el) => +getComputedStyle(el).opacity)).toBeGreaterThanOrEqual(0)
    // Only one underline: the old one steps aside while the new one is pending.
    await expect
      .poll(() => studyPath(page).getByRole('link', { name: /^Notes/ }).evaluate((el) => getComputedStyle(el, '::after').opacity))
      .toBe('0')
    // After the wait the old panel dims.
    await expect.poll(() => panelOpacity(page), { timeout: 1000 }).toBeLessThan(0.7)

    await expect(page).toHaveURL(/view=practice/)
    await expect(practice).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-tab-pending]')).toHaveCount(0)
    expect(await panelOpacity(page)).toBe(1)
    const report = await tabsReport(page)
    expect(report.latency, 'underline latency after the click, ms').not.toBeNull()
    expect(report.latency!).toBeLessThan(100)
    console.log(`tab underline appeared ${Math.round(report.latency!)} ms after the click`)
  })

  test('a fast load never dims the view', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
    await slowPages(page, 40)
    await watchTabs(page)
    await studyPath(page).getByRole('link', { name: /^Practice/ }).click()
    await expect(page).toHaveURL(/view=practice/)
    await page.waitForTimeout(500)
    const report = await tabsReport(page)
    expect(report.minOpacity).toBe(1)
  })

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the pending underline and the dim still show, without a fade', async ({ page }) => {
      await signIn(page, DEMO_EMAIL)
      await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
      await slowPages(page, 800)
      const practice = studyPath(page).getByRole('link', { name: /^Practice/ })
      await practice.click()
      await expect(practice.locator('[data-tab-pending]')).toBeAttached({ timeout: 150 })
      await expect.poll(() => panelOpacity(page), { timeout: 1000 }).toBeLessThan(0.7)
      const durations = await page.evaluate(() => {
        const ms = (value: string) => Math.max(...value.split(',').map((part) => parseFloat(part) * (part.includes('ms') ? 1 : 1000)))
        const indicator = getComputedStyle(document.querySelector('[data-tab-indicator]')!)
        const panel = getComputedStyle(document.querySelector('[data-tab-panel]')!)
        return [ms(indicator.transitionDuration), ms(panel.transitionDuration)]
      })
      for (const duration of durations) expect(duration).toBeLessThanOrEqual(0.001)
      await expect(page).toHaveURL(/view=practice/)
      expect(await panelOpacity(page)).toBe(1)
    })
  })

  test('switching while the tabs are stuck keeps them at the top, with the new view under them', async ({ page }) => {
    // A short window, so the views are taller than it: a page that fits in the window cannot scroll at all.
    await page.setViewportSize({ width: 1440, height: 500 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
    const nav = studyPath(page)
    const stickyTop = await nav.evaluate((el) => parseFloat(getComputedStyle(el).top))
    const navTop = () => nav.evaluate((el) => Math.round(el.getBoundingClientRect().top))
    const heights = async () =>
      page.evaluate(() => ({ doc: document.documentElement.scrollHeight, panel: document.querySelector('[data-tab-panel]')!.getBoundingClientRect().height }))

    // Not stuck (top of the page): the scroll stays where it is.
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await nav.getByRole('link', { name: /^Worked examples/ }).click()
    await expect(page).toHaveURL(/view=examples/)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    // Stuck: scroll down inside whichever view is long enough, then switch to another long one.
    await nav.getByRole('link', { name: /^Notes/ }).click()
    await expect(page).toHaveURL(/view=notes/)
    const notes = await heights()
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    expect(await navTop()).toBe(stickyTop)
    const before = await page.evaluate(() => window.scrollY)
    await nav.getByRole('link', { name: /^Worked examples/ }).click()
    await expect(page).toHaveURL(/view=examples/)
    const examples = await heights()
    console.log('notes', notes, 'examples', examples, 'scrollY before', before)
    // The view has to be tall enough for the page to scroll that far at all.
    expect(examples.panel + stickyTop + 41).toBeGreaterThan(500)
    expect(await navTop()).toBe(stickyTop)
    const panelTop = await page.evaluate(() => Math.round(document.querySelector('[data-tab-panel]')!.getBoundingClientRect().top))
    expect(panelTop).toBeLessThanOrEqual(stickyTop + 41 + 1)
    await expect(page.locator('[data-tab-panel]').locator('h2, h3, [role="heading"]').first()).toBeInViewport()
  })
})

test.describe('pinned scroll belongs to the tab that was clicked', () => {
  test.use({ viewport: { width: 1440, height: 500 } })

  test('a click that is replaced before it lands (the 3 key) does not scroll the page to the top of the view', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
    const nav = studyPath(page)
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    await slowPages(page, 1500)
    // Examples is clicked while the tabs are stuck, then the 3 key goes to Practice before Examples lands.
    await nav.getByRole('link', { name: /^Worked examples/ }).click()
    await page.keyboard.press('3')
    await expect(page).toHaveURL(/view=practice/)
    await page.waitForTimeout(300)
    const { scrollY, pinned } = await page.evaluate(() => {
      const nav = document.querySelector('[data-tabs]') as HTMLElement
      const panel = document.querySelector('[data-tab-panel]')!
      return {
        scrollY: Math.round(window.scrollY),
        pinned: Math.round(panel.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(nav).top) - nav.offsetHeight),
      }
    })
    const maxScroll = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - window.innerHeight))
    // The browser's own clamp, not the pinned position of a click that did not land.
    expect(Math.abs(scrollY - Math.min(maxScroll, 1e9))).toBeLessThanOrEqual(2)
    expect(pinned, 'the pinned position differs from the clamp, so the check means something').not.toBe(maxScroll)
  })

  test('Back after a pinned switch does not scroll to the top of the earlier view', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${topicUrl}?view=notes`, { waitUntil: 'networkidle' })
    const nav = studyPath(page)
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    await nav.getByRole('link', { name: /^Worked examples/ }).click()
    await expect(page).toHaveURL(/view=examples/)
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    await page.goBack()
    await expect(page).toHaveURL(/view=notes/)
    await page.waitForTimeout(300)
    const { scrollY, maxScroll } = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    }))
    // Back is not a click on a tab: the page is where the browser leaves it, never above the clamp by a pin.
    expect(scrollY).toBeGreaterThan(0)
    expect(scrollY).toBeLessThanOrEqual(maxScroll)
  })
})

test.describe('sidebar unit groups', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  const unitHeight = (page: Page) => page.locator('ul[data-collapsible]').first().evaluate((el) => el.getBoundingClientRect().height)

  async function sampleHeights(page: Page, toggle: () => Promise<void>) {
    await page.evaluate(() => {
      const w = window as unknown as { __h: number[]; __stop: boolean }
      w.__h = []
      w.__stop = false
      const list = document.querySelector('ul[data-collapsible]')!
      const tick = () => {
        w.__h.push(Math.round(list.getBoundingClientRect().height))
        if (!w.__stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await toggle()
    await page.waitForTimeout(600)
    return page.evaluate(() => {
      const w = window as unknown as { __h: number[]; __stop: boolean }
      w.__stop = true
      return w.__h
    })
  }

  test('a group opens and closes with a height transition', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
    const header = page.locator('button[aria-controls][aria-expanded]').first()
    await expect(header).toBeVisible()
    const expanded = (await header.getAttribute('aria-expanded')) === 'true'
    // Close, then open: both must pass through heights between 0 and the full height.
    if (!expanded) await header.click()
    await page.waitForTimeout(400)
    const open = await unitHeight(page)
    expect(open).toBeGreaterThan(0)
    const closing = await sampleHeights(page, () => header.click())
    expect(closing.some((h) => h > 0 && h < open), `closing heights ${closing}`).toBe(true)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(await page.locator('ul[data-collapsible]').first().isHidden()).toBe(true)
    const opening = await sampleHeights(page, () => header.click())
    expect(opening.some((h) => h > 0 && h < open), `opening heights ${opening}`).toBe(true)
    expect(opening[opening.length - 1]).toBe(open)
  })

  /** Starts sampling the height of every open group each frame, from the first frame of the next page load. */
  const sampleFromLoad = (page: Page) =>
    page.addInitScript(() => {
      const w = window as unknown as { __open: number[] }
      w.__open = []
      const tick = () => {
        for (const list of document.querySelectorAll('ul[data-collapsible]:not([hidden])')) if (list.getClientRects().length > 0) w.__open.push(Math.round(list.getBoundingClientRect().height))
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  const openSamples = (page: Page) => page.evaluate(() => (window as unknown as { __open: number[] }).__open)

  test('a group that is open on a page load is there at once, not grown from nothing', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await sampleFromLoad(page)
    await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
    await expect(page.locator('ul[data-collapsible]:not([hidden])').first()).toBeVisible()
    await page.waitForTimeout(500)
    const samples = await openSamples(page)
    expect(samples.length).toBeGreaterThan(5)
    expect(new Set(samples.filter((height) => height > 0)).size, `open group heights per frame ${samples}`).toBe(1)
    expect(samples.filter((height) => height === 0), 'frames with an open group at height 0').toEqual([])
  })

  test('the menu sheet on a phone mounts its open group at full height', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
    await sampleFromLoad(page)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(page.locator('ul[data-collapsible]:not([hidden]):visible').first()).toBeVisible()
    await page.waitForTimeout(600)
    const samples = await openSamples(page)
    expect(samples.length).toBeGreaterThan(3)
    expect(new Set(samples.filter((height) => height > 0)).size, `open group heights per frame ${samples}`).toBe(1)
  })

  test('the focus ring of the first and last link in a group is not clipped', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
    // Toggle a group once (that is what turns the clipping on), then focus its first and last link by keyboard.
    const header = page.locator('button[aria-controls][aria-expanded]').first()
    await header.click()
    await header.click()
    await page.waitForTimeout(500)
    const list = page.locator('ul[data-collapsible]:not([hidden])').first()
    await expect(list).toBeVisible()
    const clip = await list.evaluate((el) => {
      const style = getComputedStyle(el)
      return { overflowY: style.overflowY, margin: parseFloat(style.overflowClipMargin) || 0 }
    })
    // Clipped on the block axis, with at least the ring's reach (2px outline + 2px offset) outside the box.
    expect(clip.overflowY).toBe('clip')
    expect(clip.margin).toBeGreaterThanOrEqual(4)
  })

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('a group opens and closes in one step', async ({ page }) => {
      await signIn(page, DEMO_EMAIL)
      await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
      const header = page.locator('button[aria-controls][aria-expanded]').first()
      if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
      await page.waitForTimeout(300)
      const open = await unitHeight(page)
      const closing = await sampleHeights(page, () => header.click())
      expect(closing.filter((h) => h > 0 && h < open), `closing heights ${closing}`).toEqual([])
      const opening = await sampleHeights(page, () => header.click())
      expect(opening.filter((h) => h > 0 && h < open), `opening heights ${opening}`).toEqual([])
    })
  })
})
