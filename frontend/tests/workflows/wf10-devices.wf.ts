import type { Browser, Locator, Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { axeViolations } from '../e2e/helpers/axe'
import { animationsSettled } from '../e2e/helpers/settle'
import { openOnWarmup, readyCourse, startStudying, takeWarmup } from './harness/course'
import { DEVICES, firstOf, mainScreens, shownWhole, sidewaysOverflow, smallTargets, type Device } from './harness/devices'
import { preparationFinished } from './harness/files'
import { cutOffText, expectNone } from './harness/page-checks'
import { voiceScreen } from './harness/voice'

// WF10: devices. One studied topic, then the main screens on a 390x844 phone, an 820x1180 iPad with touch and a
// 1440x900 laptop, each in light and dark: touch targets, cut-off text, sideways scrolling and axe. Then the keyboard on
// the laptop (the skip link, focus coming back after a menu, a dialog and the command palette, a quiz question), and
// last the voice screen on the phone, where the coach's turn must show whole.

type Theme = 'light' | 'dark'

/**
 * How long a key is held, as a person holds it. Radix moves the focus on an arrow key in a timeout and checks the radio
 * it lands on only while the key is down, so a press with no hold moves the focus without choosing.
 */
const KEY_HELD_MS = 40

/** A new browser window for `device` in `theme`, signed in as the student of `page`. */
async function windowOn(browser: Browser, page: Page, device: Device, theme: Theme): Promise<Page> {
  const context = await browser.newContext({
    ...DEVICES[device],
    baseURL: new URL(page.url()).origin,
    storageState: await page.context().storageState(),
    timezoneId: 'America/Los_Angeles',
    colorScheme: theme,
    reducedMotion: 'reduce',
  })
  return context.newPage()
}

/** Opens a screen and waits until it has drawn: its main region shown and nothing still moving. */
async function openScreen(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('main').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState('load')
  await animationsSettled(page)
}

/** Presses Tab until `target` has the focus, at most `limit` times; whether it got there. */
async function tabTo(page: Page, isTarget: () => Promise<boolean>, limit = 80): Promise<boolean> {
  for (let presses = 0; presses < limit; presses++) {
    await page.keyboard.press('Tab')
    if (await isTarget()) return true
  }
  return false
}

/** Whether `locator`'s element has the focus. */
async function hasFocus(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && locator.first().evaluate((el) => el === document.activeElement)
}

/**
 * Takes the quiz with the keyboard alone, giving the answers takeQuiz gives (so the topic ends in the same state):
 * Tab to each control, Space or the arrow keys on a choice, typing in a box, Enter on Next and Submit. Where Tab cannot
 * reach a control it is clicked instead, and the place is returned, so the run goes on to the same results.
 */
async function takeQuizByKeyboard(page: Page, topicUrl: string): Promise<string[]> {
  const stuck: string[] = []
  const press = async (where: string, control: Locator, key = 'Enter') => {
    if (await tabTo(page, () => hasFocus(control))) await page.keyboard.press(key, { delay: KEY_HELD_MS })
    else {
      stuck.push(where)
      await control.click()
    }
  }
  await openScreen(page, `${topicUrl}?view=quiz`)
  await press('Start quiz', page.getByRole('button', { name: 'Start quiz' }))
  const heading = page.getByRole('heading', { level: 2, name: /^Question \d+ of \d+$/ })
  await expect(heading).toBeVisible()
  const total = Number((await heading.innerText()).match(/of (\d+)/)![1])
  const answer = page.getByRole('textbox', { name: 'Your answer' })
  for (let question = 1; question <= total; question++) {
    await expect(page.getByRole('heading', { level: 2, name: `Question ${question} of ${total}` })).toBeVisible()
    const options = page.getByRole('radiogroup', { name: /^(Answer options|True or false)$/ })
    if (question === 2) await press(`question 2's "I don't know"`, page.getByRole('button', { name: "I don't know" }))
    else if (await options.isVisible()) {
      const radios = options.getByRole('radio')
      // Tab lands on the first choice; Space picks it, or the down arrow moves to the second and picks that.
      await press(`question ${question}'s choices`, radios.first(), question % 2 ? 'ArrowDown' : 'Space')
      if ((await radios.nth(question % 2).getAttribute('aria-checked')) !== 'true') {
        stuck.push(`question ${question}'s choice by arrow key`)
        await radios.nth(question % 2).click()
      }
    } else {
      const text = (await answer.getAttribute('inputmode')) === 'decimal' ? '2' : 'It is correct for every input because each step keeps the invariant, shown by induction on the input size.'
      if (await tabTo(page, () => hasFocus(answer))) await page.keyboard.type(text)
      else {
        stuck.push(`question ${question}'s answer box`)
        await answer.fill(text)
      }
    }
    if (question < total) await press(`question ${question}'s Next`, page.getByRole('button', { name: 'Next', exact: true }))
  }
  await press('Submit quiz', page.getByRole('button', { name: 'Submit quiz' }).last())
  await expect(page.getByLabel(/^Score /)).toBeVisible({ timeout: 3 * 60_000 })
  return stuck
}

/** What has the focus, as a short description. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return 'the page itself'
    return `${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`
  })
}

test('WF10 devices: phone, iPad and laptop, light and dark, the keyboard and the phone voice screen', async ({ page, browser, checks }) => {
  test.setTimeout(30 * 60_000)
  const { courseUrl } = await readyCourse(page, 'WF10')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!

  // The quiz waits for the keyboard step, so the screens show its lobby and the keyboard has a quiz to start.
  await test.step('a studied topic: warm-up and reading, prepared to its end', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await page.goto(`${topicUrl}?view=read`)
    await page.getByRole('button', { name: "I've read it" }).click()
    await expect(page.getByText("You've read this topic.")).toBeVisible()
    await preparationFinished(topicId)
  })

  const screens = mainScreens(courseUrl, topicUrl)
  const small: Record<'phone' | 'ipad', string[]> = { phone: [], ipad: [] }
  const cut: Record<'phone' | 'ipad', string[]> = { phone: [], ipad: [] }
  const sideways: string[] = []
  const axe: Record<Theme, string[]> = { light: [], dark: [] }
  for (const device of ['phone', 'ipad', 'desktop'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await test.step(`the main screens on the ${device}, ${theme}`, async () => {
        const window = await windowOn(browser, page, device, theme)
        for (const [screen, url] of screens) {
          await openScreen(window, url)
          if (theme === 'light' && device !== 'desktop') {
            small[device].push(...(await smallTargets(window)).map((target) => `${screen}: ${target}`))
            cut[device].push(...(await cutOffText(window)).map((text) => `${screen}: ${text}`))
            const overflow = await sidewaysOverflow(window)
            if (overflow > 0) sideways.push(`${device} ${screen}: ${overflow} px`)
          }
          axe[theme].push(...(await axeViolations(window)).map((violation) => `${device} ${screen}: ${violation.slice(0, 160)}`))
        }
        await window.context().close()
      })
    }
  }

  await checks.check('WF10.touch-targets-ipad', 'every control on the main screens is a 44 px target on an iPad with touch (SW5, 41)', () =>
    expectNone(firstOf(small.ipad), 'small targets on the iPad')
  )
  await checks.check('WF10.touch-targets-phone', 'every control on the main screens is a 44 px target on a phone (SW5, U5, 41)', () =>
    expectNone(firstOf(small.phone), 'small targets on the phone')
  )
  await checks.check('WF10.cut-off-text-ipad', 'no text on the main screens is cut off on an iPad without its full form (SW6, 20, 87)', () =>
    expectNone(firstOf(cut.ipad), 'cut-off text on the iPad')
  )
  await checks.check('WF10.cut-off-text-phone', 'no text on the main screens is cut off on a phone without its full form (SW6, 20, 43)', () =>
    expectNone(firstOf(cut.phone), 'cut-off text on the phone')
  )
  await checks.check('WF10.no-sideways-scroll', 'no main screen scrolls sideways on a phone or an iPad', () => expectNone(sideways, 'sideways scrolling'))
  await checks.check('WF10.axe-light', 'axe finds nothing on the main screens in light, on every device', () => expectNone(firstOf(axe.light), 'axe, light'))
  await checks.check('WF10.axe-dark', 'axe finds nothing on the main screens in dark, on every device', () => expectNone(firstOf(axe.dark), 'axe, dark'))

  await test.step('the keyboard on the laptop', async () => {
    await openScreen(page, `${topicUrl}?view=read`)
    await page.keyboard.press('Tab')
    const first = await focused(page)
    await page.keyboard.press('Enter')
    const afterSkip = await page.evaluate(() => !!document.activeElement?.closest('main') || document.activeElement?.tagName === 'MAIN')
    await checks.check('WF10.skip-link', 'the first Tab on a screen reaches "Skip to content", and it moves the focus into the main region', () => {
      expect(first).toContain('Skip to content')
      expect(afterSkip, 'the focus after Enter').toBe(true)
    })

    const more = page.getByRole('button', { name: 'More actions' })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    const afterMenu = await more.evaluate((el) => el === document.activeElement)
    await more.focus()
    await page.keyboard.press('Enter')
    const regenerate = page.getByRole('menuitem', { name: 'Regenerate notes' })
    await expect(regenerate).toBeVisible()
    await regenerate.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Regenerate notes' })
    await expect(dialog).toBeVisible()
    const inDialog = await dialog.evaluate((el) => el.contains(document.activeElement))
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    const afterDialog = await focused(page)
    await checks.check('WF10.focus-returns', 'closing a menu or a dialog opened from it puts the focus back on the button that opened them', () => {
      expect(afterMenu, 'after the menu').toBe(true)
      expect(inDialog, 'the dialog takes the focus').toBe(true)
      expect(afterDialog, 'after the dialog').toContain('More actions')
    })

    await more.focus()
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    const afterPalette = await focused(page)
    await checks.check('WF10.palette-focus-returns', 'closing the command palette puts the focus back where it was', () => expect(afterPalette).toContain('More actions'))

    const stuck = await takeQuizByKeyboard(page, topicUrl)
    await checks.check('WF10.quiz-by-keyboard', 'a whole quiz can be taken with the keyboard: Tab, Space, the arrow keys, typing and Enter', () =>
      expectNone(stuck, 'not reached by keyboard')
    )
  })

  await test.step('the voice screen on the phone', async () => {
    const phone = await windowOn(browser, page, 'phone', 'light')
    const voice = voiceScreen(phone)
    await phone.goto(`${topicUrl}?view=voice`)
    await voice.chooseTypedQuiz()
    await voice.start.click()
    await expect(voice.question).toBeVisible({ timeout: 60_000 })
    await voice.ready()
    const turn = (await phone.getByTestId('voice-coach-turn').count()) ? '[data-testid="voice-coach-turn"]' : '[data-testid="voice-question"]'
    const { whole, hidden } = await shownWhole(phone, turn)
    await checks.check('WF10.phone-voice-turn-whole', "on a phone the coach's latest turn shows whole, with no scrolling inside a strip (V6, 86)", () =>
      expect(whole, `${hidden} px of it hidden`).toBe(true)
    )
    await voice.end()
    await phone.context().close()
  })
})
