import test from 'node:test'
import assert from 'node:assert/strict'
import SCREENS from './screens.json'
import { SLOT_SIZES, mobileStem, screenFile, shotSources, type ScreensManifest } from './shot-sources'

const manifest: ScreensManifest = {
  plan: { widths: [2592, 960, 1920], width: 2592, height: 1772 },
  'plan-mobile': { widths: [390, 780, 1170], width: 1170, height: 2100 },
  single: { widths: [800], width: 800, height: 600 },
}

test('screenFile names one version at one width', () => {
  assert.equal(screenFile('plan', 'dark', 1920), '/screens/plan-dark-1920.webp')
  assert.equal(screenFile(mobileStem('notes-detail'), 'light', 390), '/screens/notes-detail-mobile-light-390.webp')
})

test('shotSources lists every width, smallest first, with w descriptors', () => {
  const sources = shotSources(manifest, 'plan', 'light')
  assert.equal(sources.srcSet, '/screens/plan-light-960.webp 960w, /screens/plan-light-1920.webp 1920w, /screens/plan-light-2592.webp 2592w')
  assert.equal(sources.src, '/screens/plan-light-1920.webp')
  assert.deepEqual([sources.width, sources.height], [2592, 1772])
})

test('shotSources serves the theme asked for', () => {
  assert.match(shotSources(manifest, 'plan-mobile', 'dark').srcSet, /^\/screens\/plan-mobile-dark-390\.webp 390w, /)
})

test('shotSources with one width uses it as src', () => {
  assert.equal(shotSources(manifest, 'single', 'light').src, '/screens/single-light-800.webp')
})

test('shotSources fails loudly for a screen that was never captured', () => {
  assert.throws(() => shotSources(manifest, 'missing', 'light'), /npm run screens/)
})

/**
 * What a browser makes of a `sizes` value at a viewport width: the first entry whose media query matches, as CSS
 * px. Handles what SLOT_SIZES uses: `(min-width: Npx)` and lengths in px, vw and calc() with + - * /.
 */
function slotWidth(sizes: string, viewport: number): number {
  const entries = sizes.split(/,(?![^(]*\))/).map((entry) => entry.trim())
  for (const entry of entries) {
    const media = /^\(min-width:\s*(\d+)px\)\s+(.+)$/.exec(entry)
    if (media && viewport < Number(media[1])) continue
    return evaluate(media ? media[2] : entry, viewport)
  }
  throw new Error(`no entry of "${sizes}" matches ${viewport}px`)
}

function evaluate(length: string, viewport: number): number {
  const tokens = length.replace(/^calc/, '').match(/\d+(?:\.\d+)?(?:px|vw)?|[-+*/()]/g) ?? []
  let index = 0
  const value = (token: string) => (token.endsWith('vw') ? (parseFloat(token) * viewport) / 100 : parseFloat(token))
  const factor = (): number => {
    const token = tokens[index++]
    if (token === '(') {
      const inner = sum()
      index++ // ')'
      return inner
    }
    return value(token)
  }
  const product = (): number => {
    let result = factor()
    while (tokens[index] === '*' || tokens[index] === '/') result = tokens[index++] === '*' ? result * factor() : result / factor()
    return result
  }
  const sum = (): number => {
    let result = product()
    while (tokens[index] === '+' || tokens[index] === '-') result = tokens[index++] === '+' ? result + product() : result - product()
    return result
  }
  return sum()
}

test('slotWidth reads media queries and calc()', () => {
  assert.equal(slotWidth('(min-width: 1000px) 500px, calc((100vw - 100px) * 1 / 2 + 10px)', 1200), 500)
  assert.equal(slotWidth('(min-width: 1000px) 500px, calc((100vw - 100px) * 1 / 2 + 10px)', 900), 410)
  assert.equal(slotWidth('calc(100vw - 34px)', 390), 356)
})

/**
 * The image box widths (CSS px) measured with a real browser on the landing and sign-in pages
 * (getBoundingClientRect of each <img>, 2026-10-28). Each slot's `sizes` must match them to the pixel.
 */
const MEASURED: [slot: keyof typeof SLOT_SIZES, viewport: number, width: number][] = [
  ['hero', 1920, 741],
  ['hero', 1440, 741],
  ['hero', 1280, 741],
  ['hero', 1100, 627],
  ['hero', 800, 734],
  ['phone', 390, 356],
  ['loopPanel', 1920, 679],
  ['loopPanel', 1440, 679],
  ['loopPanel', 1280, 679],
  ['loopPanel', 1100, 574],
  ['loopList', 800, 734],
  ['ask', 1920, 628],
  ['ask', 1440, 628],
  ['ask', 1280, 628],
  ['ask', 1100, 523],
  ['ask', 800, 668],
  ['askPhone', 390, 306],
  ['auth', 1920, 1294],
  ['auth', 1440, 814],
  ['auth', 1280, 654],
  ['auth', 1100, 506],
]

test('every slot size matches the width measured in the browser', () => {
  for (const [slot, viewport, width] of MEASURED) {
    assert.ok(Math.abs(slotWidth(SLOT_SIZES[slot], viewport) - width) <= 1, `${slot} at ${viewport}px: sizes gives ${slotWidth(SLOT_SIZES[slot], viewport)}, measured ${width}`)
  }
})

/** The candidate a browser takes from a srcset: the smallest at least as dense as the screen, else the largest. */
function pick(widths: number[], slot: number, dpr: number) {
  const sorted = [...widths].sort((a, b) => a - b)
  return sorted.find((width) => width / slot >= dpr) ?? sorted[sorted.length - 1]
}

/** Each screen as the site draws it: its slot, and the screens it is drawn on (viewport width, device pixel ratio). */
const DESKTOP_SCREENS: [number, number][] = [
  [800, 1],
  [800, 2],
  [1100, 1],
  [1100, 2],
  [1280, 2],
  [1440, 1],
  [1440, 2],
  [1920, 1],
  [1920, 2],
]
const PHONE_SCREENS: [number, number][] = [
  [360, 3],
  [390, 3],
  [430, 2],
]
const USES: { stems: string[]; slot: keyof typeof SLOT_SIZES; screens: [number, number][] }[] = [
  { stems: ['plan'], slot: 'hero', screens: DESKTOP_SCREENS },
  { stems: ['plan'], slot: 'auth', screens: DESKTOP_SCREENS.filter(([viewport]) => viewport >= 1024) },
  { stems: ['materials', 'topics-edit', 'plan-exam-day', 'notes-detail', 'exam-new', 'quiz-results'], slot: 'loopPanel', screens: DESKTOP_SCREENS.filter(([viewport]) => viewport >= 1024) },
  { stems: ['materials', 'topics-edit', 'plan-exam-day', 'notes-detail', 'exam-new', 'quiz-results'], slot: 'loopList', screens: DESKTOP_SCREENS.filter(([viewport]) => viewport < 1024) },
  { stems: ['ask'], slot: 'ask', screens: DESKTOP_SCREENS },
  { stems: ['ask-mobile'], slot: 'askPhone', screens: PHONE_SCREENS },
  {
    stems: ['plan', 'materials', 'topics-edit', 'plan-exam-day', 'notes-detail', 'exam-new', 'quiz-results'].map(mobileStem),
    slot: 'phone',
    screens: PHONE_SCREENS,
  },
]

test('every screenshot on the site is served at least as dense as the screen, up to 1920px wide', () => {
  const screens = SCREENS as ScreensManifest
  for (const { stems, slot, screens: on } of USES) {
    for (const stem of stems) {
      const entry = screens[stem]
      assert.ok(entry, `${stem} is missing from screens.json`)
      for (const [viewport, dpr] of on) {
        const width = slotWidth(SLOT_SIZES[slot], viewport)
        const chosen = pick(entry.widths, width, dpr)
        assert.ok(chosen / width >= dpr, `${stem} in ${slot} at ${viewport}px x${dpr}: needs ${Math.ceil(width * dpr)}px, largest is ${chosen}px`)
      }
    }
  }
})

test('the screenshots for the 4:3 frames are exactly 4:3', () => {
  const screens = SCREENS as ScreensManifest
  for (const stem of ['materials', 'topics-edit', 'plan-exam-day', 'notes-detail', 'exam-new', 'quiz-results', 'ask']) {
    const { width, height } = screens[stem]
    assert.equal(width * 3, height * 4, `${stem} is ${width}x${height}, not 4:3`)
  }
})
