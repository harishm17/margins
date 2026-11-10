import type { Page } from '@playwright/test'

/** The devices WF10 studies on: a phone, an iPad held upright (touch, but wider than the phone layout) and a laptop. */
export const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
  ipad: { viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 }, hasTouch: false },
} as const
export type Device = keyof typeof DEVICES

/** The main screens of a course with one studied topic, by name. */
export function mainScreens(courseUrl: string, topicUrl: string): [string, string][] {
  return [
    ['home', '/home'],
    ['course', courseUrl],
    ['files', `${courseUrl}/materials`],
    ['topics', `${courseUrl}/topics`],
    ['plan', `${courseUrl}/plan`],
    ['review', `${courseUrl}/review`],
    ['Ask', `${courseUrl}/ask`],
    ['notes', `${topicUrl}?view=read`],
    ['practice', `${topicUrl}?view=practice`],
    ['quiz', `${topicUrl}?view=quiz`],
    ['voice', `${topicUrl}?view=voice`],
    ['settings', '/settings'],
  ]
}

/**
 * Where a finger must land on a control for its target to count as `size` px: the middle of each side of a square that
 * size around the control's centre (SW5's 44 px; WCAG 2.5.5).
 */
export function probeOffsets(size = 44): [number, number][] {
  const half = size / 2 - 0.5
  return [
    [-half, 0],
    [half, 0],
    [0, -half],
    [0, half],
  ]
}

/** At most `limit` items, then how many more: a long list stays readable in a check's message. */
export function firstOf(items: readonly string[], limit = 25): string[] {
  return items.length > limit ? [...items.slice(0, limit), `and ${items.length - limit} more`] : [...items]
}

/** Where one probe point of a control landed. */
export type Probe = { inside: boolean; offScreen: boolean; hitOwn: boolean }

/**
 * Whether a finger aimed at a control can miss it: some probe point is outside its box, on the screen, and hits
 * something else. A point inside the box is the control's even when a bar is laid over it there: the box is the
 * target's size, and what covers it is another problem. A point outside the box that still hits the control is a
 * wider hit area (a pseudo-element). The edge of the screen stops the finger.
 */
export function missable(probes: readonly Probe[]): boolean {
  return !probes.every((probe) => probe.inside || probe.offScreen || probe.hitOwn)
}

/**
 * SW5: the controls on the page a finger can miss: those whose square of `size` px around the centre is not all theirs
 * (`missable`). Skipped: controls hidden or covered at their centre, visually hidden ones (a skip link until focused),
 * and links inside a sentence, which the sentence sizes. A native checkbox or radio is measured by its label.
 */
export async function smallTargets(page: Page, size = 44): Promise<string[]> {
  const controls = await page.evaluate((offsets) => {
    const SELECTOR =
      'a[href], button, summary, select, input[type=checkbox], input[type=radio], [role=button], [role=link], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=menuitem], [role=option]'
    const out: { label: string; probes: { inside: boolean; offScreen: boolean; hitOwn: boolean }[] }[] = []
    for (const control of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      if (control.closest('[aria-hidden="true"], [inert]')) continue
      const native = control instanceof HTMLInputElement
      const el = native && control.labels?.[0] ? control.labels[0] : control
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      let rect = el.getBoundingClientRect()
      if (rect.width <= 2 || rect.height <= 2) continue
      const sentence = (el.parentElement?.textContent ?? '').trim().length
      if (el.tagName === 'A' && style.display === 'inline' && sentence > (el.textContent ?? '').trim().length + 20) continue
      el.scrollIntoView({ block: 'center', inline: 'center' })
      rect = el.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const hitsOwn = (px: number, py: number) => {
        const hit = document.elementFromPoint(px, py)
        return !!hit && (hit === el || el.contains(hit) || hit === control)
      }
      if (!hitsOwn(x, y)) continue
      const probes = offsets.map(([dx, dy]) => {
        const [px, py] = [x + dx, y + dy]
        const offScreen = px < 0 || py < 0 || px >= innerWidth || py >= innerHeight
        const inside = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom
        return { inside, offScreen, hitOwn: !offScreen && !inside && hitsOwn(px, py) }
      })
      const name = (control.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      out.push({ label: `${control.getAttribute('role') ?? control.tagName.toLowerCase()} "${name}" ${Math.round(rect.width)}x${Math.round(rect.height)}`, probes })
    }
    window.scrollTo(0, 0)
    return out
  }, probeOffsets(size))
  return [...new Set(controls.filter((control) => missable(control.probes)).map((control) => control.label))]
}

/** How far the page scrolls sideways past the screen, in px (0 when it fits). */
export async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))
}

/**
 * V6: whether an element shows whole: inside the screen and inside every box between it and the page that clips it,
 * as it is now, with no scrolling.
 */
export async function shownWhole(page: Page, selector: string): Promise<{ whole: boolean; hidden: number }> {
  return page.locator(selector).last().evaluate((el) => {
    const rect = el.getBoundingClientRect()
    let top = Math.max(0, rect.top)
    let bottom = Math.min(innerHeight, rect.bottom)
    for (let box = el.parentElement; box; box = box.parentElement) {
      const style = getComputedStyle(box)
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        const clip = box.getBoundingClientRect()
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
    const shown = Math.max(0, bottom - top)
    return { whole: shown >= rect.height - 1, hidden: Math.round(rect.height - shown) }
  })
}
