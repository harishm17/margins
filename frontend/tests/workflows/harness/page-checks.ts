import { expect, type Locator, type Page } from '@playwright/test'
import { conceptNameOf, misusedConcepts, unrenderedText } from './text-checks'

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

/**
 * SW1 for a whole workflow: from now on, every button that turns busy with no visible text is recorded, however
 * briefly (a replayed answer can come back within a frame, so sampling would miss it). Returns a reader.
 */
export async function watchBusyButtons(page: Page): Promise<() => string[]> {
  const found = new Set<string>()
  await page.exposeBinding('__wfBlankBusy', (source, label: string) => {
    found.add(`${label} (on ${new URL(source.page.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id')})`)
  })
  await page.addInitScript(() => {
    const scan = () => {
      for (const button of document.querySelectorAll<HTMLElement>('button')) {
        const busy = button.getAttribute('aria-busy') === 'true' || button.querySelector('.animate-spin') !== null
        if (!busy || button.offsetParent === null || (button.innerText ?? '').trim() !== '') continue
        ;(window as unknown as { __wfBlankBusy?: (label: string) => void }).__wfBlankBusy?.(button.getAttribute('aria-label') || (button.textContent ?? '').trim() || button.outerHTML.slice(0, 80))
      }
    }
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'class', 'disabled'] })
  })
  return () => [...found]
}

/**
 * SW2 on a screen, or one region of it: the visible text of each block in main or in the region (rendered maths,
 * code and form fields left out), judged by `unrenderedText`. Returns each problem once.
 */
export async function unrendered(scope: Page | Locator): Promise<string[]> {
  const root = 'locator' in scope && !('goto' in scope) ? scope : (scope as Page).locator('main')
  const blocks = await root.evaluate((main) => {
    const skip = '.katex, code, pre, textarea, input, script, style, [aria-hidden="true"]'
    const block = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, blockquote, figcaption, label, button, a, div'
    const texts = new Map<Element, string>()
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || parent.closest(skip) || parent.getClientRects().length === 0) continue
      const owner = parent.closest(block) ?? main
      texts.set(owner, (texts.get(owner) ?? '') + node.textContent)
    }
    return [...texts.values()].map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean)
  })
  return [...new Set(blocks.flatMap(unrenderedText))]
}

/** The idea names of the map's first unit (SW3 checks sentences against them). Leaves the page on the map. */
export async function ideaNames(page: Page, courseUrl: string): Promise<string[]> {
  await page.goto(`${courseUrl}/map`)
  const unit = page.locator('main').getByRole('group', { name: /: \d+ ideas$/ }).first()
  await unit.waitFor()
  return [...(await unit.ariaSnapshot()).matchAll(/- link "(.*?)"/g)].map((match) => conceptNameOf(match[1]))
}

/**
 * SW2 and SW3 on the current screen, labelled with `where`: unrendered model text, and idea names used as nouns
 * in sentences.
 */
export async function textProblems(page: Page, where: string, ideas: string[]): Promise<{ unrendered: string[]; concepts: string[] }> {
  const main = await page.locator('main').innerText()
  return {
    unrendered: (await unrendered(page)).map((problem) => `${where}: ${problem}`),
    concepts: misusedConcepts(main.replace(/\s+/g, ' '), ideas).map((problem) => `${where}: ${problem}`),
  }
}

/** Every status region's text, for waits: SW7 wants each wait to have an accessible status. */
export async function statusTexts(page: Page): Promise<string[]> {
  return page.locator('[role=status]:visible, [aria-live]:visible').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean)
  )
}

/** SW7: a wait that says about how long it takes. */
export const ESTIMATE = /about \d+ (seconds?|minutes?)|\d+ (s|sec|min) (left|to go)/i

/** Fails with `found` listed when it is not empty: the body of most page checks. */
export function expectNone(found: string[], what: string) {
  expect(found, `${what}: ${found.join('; ')}`).toEqual([])
}

/**
 * The actions in `scope` drawn as buttons: filled ones (a background) and outlined ones (a border), by name. Plain
 * links and text buttons are left out. An end screen with one main action has one filled action and no outlined one.
 */
export async function buttonLikeActions(scope: Locator): Promise<{ filled: string[]; outlined: string[] }> {
  return scope.evaluate((root) => {
    const found = { filled: [] as string[], outlined: [] as string[] }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('a, button'))) {
      if (!element.checkVisibility()) continue
      const style = getComputedStyle(element)
      const name = (element.getAttribute('aria-label') || element.innerText).replace(/\s+/g, ' ').trim()
      const filled = style.backgroundColor !== 'transparent' && !/rgba\(\d+, \d+, \d+, 0\)/.test(style.backgroundColor)
      const outlined = style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0
      if (filled) found.filled.push(name)
      else if (outlined) found.outlined.push(name)
    }
    return found
  })
}
