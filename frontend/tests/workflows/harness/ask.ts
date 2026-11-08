import type { Locator } from '@playwright/test'

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
