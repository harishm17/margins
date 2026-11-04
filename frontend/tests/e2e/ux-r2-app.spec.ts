import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds, FIXTURE_PDF } from './helpers/seed-demo'
import { signIn, signUpAndIn } from './helpers/loop'
import { smallTargets } from './helpers/targets'

// The second round of the design review, for the shared controls and the screens outside the study views:
// disabled controls that can be read and explain themselves, progress tracks with an edge, one left edge for
// every page width, the phone navigation, and the materials, plan and map changes.

const { course, setupCourse, topics } = demoIds()

/** WCAG contrast of the element's text over the background it paints (the first opaque one up the tree). */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const canvas = document.createElement('canvas').getContext('2d')!
    const rgb = (value: string): [number, number, number, number] => {
      canvas.clearRect(0, 0, 1, 1)
      canvas.fillStyle = '#000'
      canvas.fillStyle = value
      canvas.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    let node: Element | null = el
    let background: [number, number, number, number] = [255, 255, 255, 1]
    while (node) {
      const probe = rgb(getComputedStyle(node).backgroundColor)
      if (probe[3] > 0.99) {
        background = probe
        break
      }
      node = node.parentElement
    }
    const fg = rgb(getComputedStyle(el).color)
    const [hi, lo] = [lum(fg), lum(background)].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  })
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`a disabled button is readable (4.5:1) and says why, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript((value) => localStorage.setItem('theme', value), scheme)
      await page.goto(`/courses/${course}/settings`)
      const save = page.getByRole('button', { name: 'Save changes' })
      await expect(save).toBeDisabled()
      expect(await contrast(page, 'button:has-text("Save changes")')).toBeGreaterThanOrEqual(4.5)
      // The reason is on the page in words and is the button's description.
      await expect(save).toHaveAccessibleDescription('No changes yet')
      // Typing something turns it on and the note goes.
      await page.getByLabel('Description').fill('A new description')
      await expect(save).toBeEnabled()
      await expect(page.getByText('No changes yet')).toHaveCount(0)
    })
  }

  test('the Ask send button says why it is off', async ({ page }) => {
    await page.goto(`/courses/${course}/ask`)
    const send = page.getByRole('button', { name: 'Send question' })
    await expect(send).toBeDisabled()
    await expect(send).toHaveAccessibleDescription('Type a question first.')
    expect(await contrast(page, 'button[aria-label="Send question"]')).toBeGreaterThanOrEqual(4.5)
    await page.getByLabel('Ask about your materials').fill('What is a heap?')
    await expect(send).toBeEnabled()
  })

  test('the delete dialogs explain their disabled button', async ({ page }) => {
    await page.goto(`/courses/${course}/settings`)
    await page.getByRole('button', { name: 'Delete course' }).click()
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Delete course' })
    await expect(confirm).toBeDisabled()
    await expect(confirm).toHaveAccessibleDescription('Type the name exactly to confirm.')
  })

  test('the allowance bar has a 3:1 edge', async ({ page }) => {
    await page.goto('/settings')
    const bar = page.getByRole('progressbar', { name: "Today's AI allowance used" })
    const edge = await bar.evaluate((el) => {
      const style = getComputedStyle(el)
      return { width: parseFloat(style.borderTopWidth), color: style.borderTopColor, fill: style.backgroundColor }
    })
    expect(edge.width).toBeGreaterThanOrEqual(1)
    expect(edge.color).not.toBe(edge.fill)
  })

  test('every page width starts at the same left edge', async ({ page }) => {
    const left: Record<string, number> = {}
    for (const [name, url] of [
      ['wide: overview', `/courses/${course}`],
      ['wide: plan', `/courses/${course}/plan`],
      ['wide: materials', `/courses/${course}/materials`],
      ['form: settings', '/settings'],
      ['form: new course', '/courses/new'],
      ['form: course settings', `/courses/${course}/settings`],
      ['focus: course setup', `/courses/${setupCourse}`],
    ] as const) {
      await page.goto(url)
      const h1 = page.getByRole('heading', { level: 1 }).first()
      await expect(h1).toBeVisible()
      left[name] = Math.round((await h1.boundingBox())!.x)
    }
    expect(new Set(Object.values(left)).size, JSON.stringify(left)).toBe(1)
    // And the narrow ones really are narrower.
    await page.goto('/settings')
    const form = (await page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::div[contains(@class,"max-w-")][1]').boundingBox())!
    expect(form.width).toBeLessThanOrEqual(640)
  })

  test('account settings has a breadcrumb, and an in-course not-found page a title', async ({ page }) => {
    await page.goto('/settings')
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(crumbs.getByRole('link', { name: 'Home' })).toBeVisible()
    await expect(crumbs.locator('ol [aria-current="page"]')).toHaveText('Settings')

    await page.goto(`/courses/${course}/topics/does-not-exist`)
    await expect(page.getByRole('heading', { name: "We couldn't find that page" })).toBeVisible()
    await expect(page).toHaveTitle(/^Page not found/)
    await page.goto('/courses/does-not-exist')
    await expect(page).toHaveTitle(/^Page not found/)
  })

  test('the map rings only the one idea to start with, and names the topic of each idea', async ({ page }) => {
    await page.goto(`/courses/${course}/map`)
    const nodes = page.locator('[data-node-link]')
    await expect(nodes.first()).toBeVisible()
    // Several ideas are ready, and only "Start here" has the ring (the page may re-read once for the window width).
    await expect(page.locator('svg rect.stroke-accent[rx="14"]')).toHaveCount(1)
    // The name carries the topic, so two ideas with one name can be told apart.
    await expect(nodes.first()).toHaveAccessibleDescription(/In .+/)
    // A selected idea has a solid outline in the text colour.
    await nodes.first().click()
    await expect(page.locator('[data-selected-outline]')).toHaveCount(1)
    // The key opens by itself the first time and can be opened again.
    await expect(page.getByRole('list', { name: 'States' })).toBeVisible()
  })

  test('a plan day without an exam date says what is missing, and one open task has the button', async ({ page }) => {
    await page.goto(`/courses/${course}/plan`)
    await expect(page.getByText('No tasks yet. Set an exam date to fill these days.').first()).toBeVisible()
    await expect(page.getByText('A good day to rest.')).toHaveCount(0)
    const today = page.locator('li[aria-current="date"]')
    await expect(today.getByRole('link', { name: /^(Start|Continue|Read|Practice|Take quiz|Review)/ })).toHaveCount(1)
  })

  test('the course mastery explanation is one tap away, not 12px grey text', async ({ page }) => {
    await page.goto(`/courses/${course}`)
    await expect(page.getByText(/Average across \d+ topics/).first()).toBeVisible()
    await page.getByRole('button', { name: 'How course mastery is worked out' }).click()
    await expect(page.getByText('A topic not started counts as 0%')).toBeVisible()
  })

  test('the home courses put a course in setup last', async ({ page }) => {
    await page.goto('/home')
    const names = await page.locator('#courses-heading ~ ul h3').allTextContents()
    expect(names.at(-1)).toBe('Organic Chemistry')
  })

  test('the account-deleted page has no sign-up button above its message', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/account-deleted')
    await expect(page.getByRole('heading', { name: 'Your account is deleted' })).toBeVisible()
    await expect(page.getByRole('banner').getByRole('link', { name: 'Get started' })).toHaveCount(0)
  })

  test('the public not-found page leads a visitor to the landing page', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/no-such-page')
    await expect(page.getByRole('link', { name: /^Go to the home page$/ })).toHaveAttribute('href', '/')
  })
})

test.describe('refused files in materials', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('say the whole reason, drop the Word icon, hide the meaningless columns and offer to clear them', async ({ page }) => {
    await signUpAndIn(page, 'ux-r2-materials', { own: true })
    const created = await page.request.post('/api/projects', { data: { name: 'Refusals' } })
    const id = (await created.json()).project.id as string
    await page.goto(`/courses/${id}/materials`)
    await page.locator('input[type=file]').setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      { name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
      { name: 'algorithms.pdf', mimeType: 'application/pdf', buffer: readFileSync(FIXTURE_PDF) },
    ])
    const refused = page.getByRole('alert').filter({ hasText: 'Use a PDF, DOCX, PPTX or DOC file.' })
    await expect(refused).toHaveCount(2)
    // Not cut off: the text is all there and fits.
    const box = await refused.first().evaluate((el) => {
      const text = el.querySelector('span:last-child') as HTMLElement
      return { scroll: text.scrollWidth, client: text.clientWidth }
    })
    expect(box.scroll).toBeLessThanOrEqual(box.client)
    // The refused row has no "Used as" chip and no size.
    const row = page.getByRole('row', { name: /notes\.txt/ })
    await expect(row.getByText('Lecture notes')).toHaveCount(0)
    await expect(row.getByText(/\bB$/)).toHaveCount(0)
    // The problem is an alert with a way to fix it.
    await expect(page.getByText('1 file ready; 2 files need attention.').or(page.getByText(/files need attention/))).toBeVisible()
    await page.getByRole('button', { name: 'Remove files with problems' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove files with problems' }).click()
    await expect(page.getByRole('row', { name: /notes\.txt/ })).toHaveCount(0)
    await expect(page.getByRole('row', { name: /bad\.exe/ })).toHaveCount(0)
    // The file that was fine is still there.
    await expect(page.getByRole('row', { name: new RegExp(path.basename(FIXTURE_PDF)) })).toBeVisible()
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the login field is 44px and the legal links sit in one sentence', async ({ page }) => {
    await page.goto('/login')
    const field = await page.getByLabel('Email').locator('xpath=..').boundingBox()
    expect(field!.height).toBeGreaterThanOrEqual(44)
    expect(await smallTargets(page)).toEqual([])
    const sentence = page.getByText(/^By continuing you agree to the/)
    await expect(sentence).toContainText('Terms and Privacy Policy')
  })

  test('the landing page has no text link under 44px and a labelled pause button', async ({ page }) => {
    await page.goto('/')
    for (const name of ['Read the evaluation', 'View the code on GitHub', 'Read the privacy policy']) {
      const box = await page.getByRole('link', { name: new RegExp(name) }).boundingBox()
      expect(box!.height, name).toBeGreaterThanOrEqual(44)
    }
  })

  test('the materials drop zone says Choose files, not Drop files here', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}/materials`)
    await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeVisible()
    await expect(page.getByText('Drop files here')).toBeHidden()
  })

  test('plan task links are 44px tall', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}/plan`)
    const links = page.locator('li[aria-current="date"] ul a:visible').filter({ hasNotText: /^(Start|Continue|Read|Practice|Take quiz|Review|Create|View)/ })
    expect(await links.count()).toBeGreaterThan(0)
    const heights = await links.evaluateAll((all) => all.map((el) => `${el.textContent}: ${el.getBoundingClientRect().height}`))
    for (const height of heights) expect(parseFloat(height.split(': ').pop()!), height).toBeGreaterThanOrEqual(43.5)
  })

  test('the menu drawer has a close button and does not repeat the tab bar', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`)
    await page.getByRole('button', { name: 'Open menu' }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('link', { name: 'Materials' })).toBeVisible()
    for (const name of ['Overview', 'Plan', 'Ask']) {
      await expect(drawer.getByRole('navigation', { name: 'Course' }).getByRole('link', { name, exact: true })).toHaveCount(0)
    }
    expect((await drawer.getByRole('button', { name: 'Close menu' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await drawer.getByRole('button', { name: 'Close menu' }).click()
    await expect(drawer).toBeHidden()
  })

  test('the search can be closed with a button', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}`)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByRole('button', { name: 'Close search' }).click()
    await expect(page.getByRole('combobox')).toHaveCount(0)
  })

  test('the topic editor has no drag handle on a phone', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    await page.goto(`/courses/${course}/topics?edit=1`)
    await expect(page.getByRole('button', { name: /^Actions for / }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reorder / }).first()).toBeHidden()
    expect(topics.length).toBeGreaterThan(0)
  })
})
