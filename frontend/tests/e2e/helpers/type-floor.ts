import type { Page } from '@playwright/test'

/**
 * Visible interactive text set under `min` px (default 13). On a phone, copy a student acts on (button and link labels, the line
 * above a control) must not be set in the 12px caption size; captions are for metadata. Same skips as `smallTargets`: hidden and
 * disabled nodes, the skip link, and visually hidden text.
 */
export async function smallInteractiveText(page: Page, min = 13): Promise<string[]> {
  return page.evaluate((limit) => {
    const selector = 'a[href], button, summary, [role=button], [role=menuitem], [role=tab], [role=radio], [role=switch], [role=link], label'
    const out = new Set<string>()
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.matches(':disabled, [aria-disabled=true], .sr-only, [data-skip-link]')) continue
      if (el.closest('[aria-hidden=true], [hidden], [inert], .sr-only')) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      // The text that is the control's own words: the text nodes directly inside it and inside its inline children.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim()
        const parent = node.parentElement
        if (!text || !parent || parent.closest('.sr-only, [aria-hidden=true]')) continue
        const size = parseFloat(getComputedStyle(parent).fontSize)
        if (size < limit - 0.01) out.add(`${el.tagName.toLowerCase()} "${text.slice(0, 40)}" ${size}px`)
      }
    }
    return [...out]
  }, min)
}
