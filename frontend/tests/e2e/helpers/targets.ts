import type { Page } from '@playwright/test'

/**
 * Every interactive node on the page that a finger could miss: smaller than `min` px in either direction.
 * The hit area counts what a student can press, so an absolutely positioned ::after strip that widens a
 * link (the Button link variant, SourceLink) counts too. Hidden nodes, the visually hidden inputs behind
 * Radix controls, the skip link (off screen until focused) and disabled controls are not reported.
 */
export async function smallTargets(page: Page, min = 44): Promise<string[]> {
  return page.evaluate((limit) => {
    const selector = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=tab], [role=radio], [role=switch], [role=link], [cmdk-item]'
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.matches(':disabled, [aria-disabled=true]')) continue
      if (el.closest('[aria-hidden=true], [hidden], [inert], .sr-only')) continue
      if (el.matches('.sr-only, [data-skip-link]') || el.getAttribute('href') === '#main') continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      // A field's hit area is its bordered box (the Input wrapper), not the bare input inside it.
      const box = (el instanceof HTMLInputElement && el.parentElement ? el.parentElement : el).getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      // A hidden-but-present control (opacity 0 behind a styled one) is not what the student presses.
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && style.opacity === '0') continue
      let width = box.width
      let height = box.height
      const after = getComputedStyle(el, '::after')
      if (after.position === 'absolute' && after.content !== 'none') {
        const afterHeight = parseFloat(after.height)
        // Only the inset-x-0 strips used by this app: as wide as the element, `h` tall.
        if (Number.isFinite(afterHeight)) height = Math.max(height, afterHeight)
      }
      // The box that wraps a Radix checkbox/radio or a label is the hit area when the label is the control.
      const label = el.closest('label')
      if (label && label !== el) {
        const lb = label.getBoundingClientRect()
        width = Math.max(width, lb.width)
        height = Math.max(height, lb.height)
      }
      // A text link is as wide as its words (a short word like "Terms" is under 44px wide); its height is what a thumb misses.
      const textLink = el.tagName === 'A' && (el.textContent ?? '').trim().length > 0
      if ((!textLink && width < limit - 0.5) || height < limit - 0.5) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
        out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? ''}] "${name}" ${Math.round(width)}x${Math.round(height)}`)
      }
    }
    return out
  }, min)
}
