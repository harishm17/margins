import { expect, type Locator, type Page } from '@playwright/test'

/** A source marker in a reply, and its block's text up to it (earlier markers' numbers included). */
export type MarkerPlace = { marker: string; before: string }

/** Words a supported phrase starts with: a marker right after one sits before the words it supports. */
const LEADS_IN = /(?:^|\s)(?:a|an|the|of|to|in|on|at|for|with|by|from|into|and|or)$/i

/** Finding 8: markers that do not follow the words they support. Each problem quotes what precedes the marker. */
export function markerProblems(places: readonly MarkerPlace[]): string[] {
  return places.flatMap(({ marker, before }) => {
    const text = before.replace(/\s+/g, ' ').trim()
    if (!text) return [`marker ${marker} at the start of its block`]
    return LEADS_IN.test(text) ? [`marker ${marker} after "${text.slice(-40)}"`] : []
  })
}

/** Every source marker in a reply (a pill, or "[n]" when its source is missing), with its block's text up to it. */
export async function markerPlaces(reply: Locator): Promise<MarkerPlace[]> {
  return reply.evaluate((article) => {
    const markers = [...article.querySelectorAll('button[aria-label^="Source "], sup')].filter((node) =>
      node.tagName === 'BUTTON' ? /^\d+$/.test((node.textContent ?? '').trim()) : /^\[\d+\]$/.test((node.textContent ?? '').trim())
    )
    return markers.map((node) => {
      const block = node.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote') ?? article
      const range = document.createRange()
      range.setStart(block, 0)
      range.setEndBefore(node)
      return { marker: (node.textContent ?? '').trim(), before: range.toString() }
    })
  })
}

/** What a student reads and uses on the Ask page. */
export function askScreen(page: Page) {
  const main = page.locator('main')
  // Finished replies; the one being written is marked busy until it is saved.
  const replies = main.locator('article:not([aria-busy])')
  const box = page.locator('form[data-ask-composer] textarea')
  return {
    suggestions: main.getByRole('list', { name: 'Suggested questions' }),
    /** The line under the empty page's heading that says what Ask does. */
    intro: main.getByRole('heading', { level: 2, name: 'Ask your materials' }).locator('xpath=following-sibling::p[1]'),
    send: async (text: string) => {
      // Straight after the page loads, its streamed copy and the one on screen can both be in the document for a moment.
      await expect(box).toHaveCount(1)
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
