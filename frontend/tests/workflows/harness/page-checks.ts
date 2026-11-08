import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Observations the plan's guards define, measured on whatever screen a workflow is on. Each returns what it
 * found (empty when all is well) so a check can say exactly what was wrong.
 */

/** SW15: sentences that appear more than once in one region (a sentence is at least five words). */
export async function repeatedSentences(region: Locator): Promise<string[]> {
  const text = await region.innerText()
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, ' '))
    .filter((sentence) => sentence.split(' ').length >= 5)
  const seen = new Map<string, number>()
  for (const sentence of sentences) seen.set(sentence, (seen.get(sentence) ?? 0) + 1)
  return [...seen].filter(([, count]) => count > 1).map(([sentence, count]) => `"${sentence}" x${count}`)
}

/**
 * SW6: elements whose text is cut off with an ellipsis or a line clamp, and whose full text is in neither their
 * title nor their accessible name (theirs or an ancestor's within three levels).
 */
export async function cutOffText(scope: Page | Locator): Promise<string[]> {
  const root = 'locator' in scope && !('goto' in scope) ? scope : (scope as Page).locator('body')
  return root.evaluate((element) => {
    const out: string[] = []
    for (const el of element.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const ellipsis = style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1
      const clamped = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '' && el.scrollHeight > el.clientHeight + 1
      if (!ellipsis && !clamped) continue
      const full = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
      if (!full) continue
      let named = false
      for (let node: HTMLElement | null = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
        const labels = [node.getAttribute('title'), node.getAttribute('aria-label')].map((value) => (value ?? '').replace(/\s+/g, ' '))
        if (labels.some((label) => label.includes(full))) named = true
      }
      if (!named) out.push(`"${full.slice(0, 80)}" (${ellipsis ? 'ellipsis' : 'line clamp'})`)
    }
    return out
  })
}

/** SW1: buttons that are busy (aria-busy or a spinner) and show no text. */
export async function blankBusyButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button')]
      .filter((button) => button.offsetParent !== null)
      .filter((button) => button.getAttribute('aria-busy') === 'true' || button.querySelector('.animate-spin') !== null)
      .filter((button) => (button.innerText ?? '').trim() === '')
      .map((button) => button.getAttribute('aria-label') ?? button.outerHTML.slice(0, 80))
  )
}

/** Every status region's text, for waits: SW7 wants each wait to have an accessible status. */
export async function statusTexts(page: Page): Promise<string[]> {
  return page.locator('[role=status]:visible, [aria-live]:visible').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean)
  )
}

/** Fails with `found` listed when it is not empty: the body of most page checks. */
export function expectNone(found: string[], what: string) {
  expect(found, `${what}: ${found.join('; ')}`).toEqual([])
}
