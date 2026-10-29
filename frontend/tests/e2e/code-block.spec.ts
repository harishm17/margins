import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, DEMO_PASSWORD, demoIds } from './helpers/seed-demo'

// A code block's Copy button sits in a bar above the code. On a phone it used to float over the
// first line. The math topic's notes hold a short block and a block with one very long line.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const { course, mathTopic } = demoIds()

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(DEMO_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/home$/, { timeout: 60_000 })
}

test('the Copy button never covers code, is a 44px target, and long lines scroll inside the block', async ({ page }) => {
  await signIn(page)
  await page.goto(`/courses/${course}/topics/${mathTopic}?view=notes`)
  const blocks = page.locator('#main .md-code')
  await expect(blocks).toHaveCount(2)

  for (let index = 0; index < 2; index++) {
    const block = blocks.nth(index)
    await block.scrollIntoViewIfNeeded()
    const button = block.getByRole('button', { name: 'Copy code' })
    const buttonBox = (await button.boundingBox())!
    // The first line of code: its height from a one-character range, its width the visible width of
    // the <pre> (a long line runs under the button when it scrolls, so the whole row counts).
    const line = await block.locator('pre').evaluate((pre) => {
      const range = document.createRange()
      const first = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT).nextNode()!
      range.setStart(first, 0)
      range.setEnd(first, 1)
      const box = range.getBoundingClientRect()
      const visible = pre.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, left: visible.left, right: visible.right }
    })
    const overlaps =
      buttonBox.x < line.right && buttonBox.x + buttonBox.width > line.left && buttonBox.y < line.bottom && buttonBox.y + buttonBox.height > line.top
    expect(overlaps, `block ${index}: Copy ${JSON.stringify(buttonBox)} overlaps first code line ${JSON.stringify(line)}`).toBe(false)
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(line.top)
    expect(buttonBox.width).toBeGreaterThanOrEqual(44)
    expect(buttonBox.height).toBeGreaterThanOrEqual(44)

    // The block itself stays inside the screen; only its <pre> scrolls.
    const blockBox = (await block.boundingBox())!
    expect(blockBox.x + blockBox.width).toBeLessThanOrEqual(390)
  }

  const pre = blocks.nth(1).locator('pre')
  expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
