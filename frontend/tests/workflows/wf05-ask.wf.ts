import type { Locator, Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { markerPlaces, markerProblems, type MarkerPlace } from './harness/ask'
import { openOnWarmup, readyCourse, startStudying } from './harness/course'
import { expectNone, ideaNames, unrendered } from './harness/page-checks'
import { misusedConcepts } from './harness/text-checks'

// WF5: Ask. The empty page and its suggestions, a suggested question, the student's own try, a citation opened, a short
// follow-up that leans on the conversation, the check question that ends an explanation, and Ask started from an idea
// on the map.

/** The student's own try at the idea the first reply asks about, the same every run: general enough for any idea. */
const ATTEMPT = 'I think it means splitting the problem into smaller parts and putting their answers together.'
const CHECK_ANSWER = 'It works on smaller parts first and then combines them.'
const FOLLOW_UP = 'Why does that matter?'

test('WF5 Ask: a question, a follow-up, a citation, a check question, the suggestions', async ({ page, checks }) => {
  test.setTimeout(20 * 60_000)
  const { courseUrl } = await readyCourse(page, 'WF5')
  await startStudying(page, courseUrl)
  // A prepared topic has ideas: the map's names are what SW3 checks Ask's sentences against.
  await openOnWarmup(page, new URL(page.url()).pathname)
  const ideas = await ideaNames(page, courseUrl)
  const main = page.locator('main')
  const ask = askScreen(page)
  const markers: MarkerPlace[] = []
  const rawAnswers: string[] = []
  const rawSuggestions: string[] = []

  /** Reads a finished reply's markers and its text (the check card has its own check). */
  async function readReply(reply: Locator, where: string) {
    markers.push(...(await markerPlaces(reply)))
    rawAnswers.push(...(await unrendered(reply.locator('.md').first())).map((problem) => `${where}: ${problem}`))
  }

  await test.step('the empty Ask page: what it says it does, the suggestions', async () => {
    await page.goto(`${courseUrl}/ask`)
    await expect(ask.suggestions.getByRole('button').first()).toBeVisible()
    const intro = await ask.intro.innerText()
    await checks.check('WF5.tagline-guides', 'the Ask page says it guides the student rather than handing out answers (E5)', () =>
      expect(intro).toMatch(/guid/i)
    )
    rawSuggestions.push(...(await unrendered(ask.suggestions)))
  })

  await test.step('a suggested question', async () => {
    const reply = await ask.reply(() => ask.suggestions.getByRole('button').first().click())
    await readReply(reply, 'the first reply')
  })

  await test.step("the student's own try", async () => {
    // The first reply asks the student to put the idea in their own words; this reply weighs what they said.
    await readReply(await ask.reply(() => ask.send(ATTEMPT)), 'the reply to the try')
  })

  await test.step('opening a citation', async () => {
    const pill = main.getByRole('button', { name: /^Source \d+: / }).first()
    let opened = 'no reply has a source marker'
    if (await pill.count()) {
      await pill.click()
      const openPage = page.getByRole('link', { name: 'Open page' })
      const excerpt = page.getByRole('button', { name: 'View excerpt' })
      await expect(openPage.or(excerpt).first()).toBeVisible()
      if (await openPage.count()) {
        const href = (await openPage.first().getAttribute('href')) ?? ''
        const response = await page.request.get(new URL(href, page.url()).toString())
        opened = `Open page (${href}) answered ${response.status()}`
      } else {
        await excerpt.first().click()
        opened = (await page.getByRole('dialog').getByRole('blockquote').count()) ? 'View excerpt showed the quote' : 'View excerpt showed nothing'
      }
      await page.keyboard.press('Escape')
    }
    await checks.check('WF5.citation-opens', 'a source marker opens its page or its excerpt', () =>
      expect(opened).toMatch(/answered 200$|showed the quote$/)
    )
  })

  await test.step('a short follow-up that leans on the conversation', async () => {
    const reply = await ask.reply(() => ask.send(FOLLOW_UP))
    await readReply(reply, 'the follow-up')
    const found = {
      sources: await reply.getByRole('region', { name: 'Sources' }).count(),
      nothingMatched: await reply.getByText('Nothing in your materials matched closely').count(),
    }
    await checks.check('WF5.follow-up-cited', `"${FOLLOW_UP}" is answered from the files, with sources (E1)`, () =>
      expect(found).toEqual({ sources: 1, nothingMatched: 0 })
    )
    await checks.check('WF5.markers-after-text', 'each source marker comes after the words it supports (8)', () => {
      expect(markers.length, 'source markers in the replies').toBeGreaterThan(0)
      expectNone(markerProblems(markers), 'misplaced markers')
    })
    await checks.check('WF5.answer-renders', 'the replies show no raw markdown or LaTeX (SW2)', () => expectNone(rawAnswers, 'unrendered'))
  })

  await test.step('a check question: an answer from memory, the answer shown, a self-grade', async () => {
    // A check question ends an explanation; on replay it is the follow-up's reply that explains, so the newest card is used.
    const card = main.getByRole('group', { name: 'Check yourself' }).last()
    if (!(await card.count())) {
      console.log('note: no reply has a check question, so there is none to answer')
      return
    }
    await card.getByRole('textbox').fill(CHECK_ANSWER)
    await card.getByRole('button', { name: 'Show the answer' }).click()
    await expect(card.getByText('The answer', { exact: true })).toBeVisible({ timeout: 60_000 })
    const raw = await unrendered(card)
    await checks.check('WF5.check-renders', 'the check question, its answer and why show no raw markdown or LaTeX (SW2)', () =>
      expectNone(raw, 'unrendered')
    )
    await card.getByRole('group', { name: 'How did you do?' }).getByRole('button', { name: 'Partly' }).click()
    await expect(card.getByText(/^(Saved|Graded): Partly/)).toBeVisible()
  })

  await test.step('Ask started from an idea on the map', async () => {
    await page.goto(`${courseUrl}/map`)
    await main.getByRole('group', { name: /: \d+ ideas$/ }).first().getByRole('link').first().click()
    const panel = page.getByTestId('node-panel')
    await panel.getByRole('button', { name: 'Other ways to study' }).click()
    await panel.getByRole('link', { name: 'Ask about this' }).click()
    await expect(page).toHaveURL(/\/ask\?concept=/)
    await expect(ask.suggestions.getByRole('button').first()).toBeVisible()
    const sentences = [await ask.intro.innerText(), ...(await ask.suggestions.getByRole('button').allInnerTexts())].join(' ')
    await checks.check('WF5.concept-sentences', "Ask started from an idea puts the idea's name into sentences that read right (SW3)", () =>
      expectNone(misusedConcepts(sentences.replace(/\s+/g, ' '), ideas), 'idea names used as nouns')
    )
    rawSuggestions.push(...(await unrendered(ask.suggestions)))
    await checks.check('WF5.suggestions-render', 'the suggested questions show no raw markdown or LaTeX (SW2)', () =>
      expectNone([...new Set(rawSuggestions)], 'unrendered')
    )
  })
})

/** What a student reads and uses on the Ask page. */
function askScreen(page: Page) {
  const main = page.locator('main')
  // Finished replies; the one being written is marked busy until it is saved.
  const replies = main.locator('article:not([aria-busy])')
  const box = page.locator('form[data-ask-composer] textarea')
  return {
    suggestions: main.getByRole('list', { name: 'Suggested questions' }),
    /** The line under the empty page's heading that says what Ask does. */
    intro: main.getByRole('heading', { level: 2, name: 'Ask your materials' }).locator('xpath=following-sibling::p[1]'),
    send: async (text: string) => {
      await box.fill(text)
      await box.press('Enter')
    },
    /** Sends a message with `send` and returns the reply once it is written and saved. */
    reply: async (send: () => Promise<void>) => {
      const before = await replies.count()
      await send()
      await expect(replies).toHaveCount(before + 1, { timeout: 4 * 60_000 })
      await expect(main.locator('article[aria-busy]')).toHaveCount(0)
      return replies.last()
    },
  }
}
