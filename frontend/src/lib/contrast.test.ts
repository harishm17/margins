import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * WCAG 2.2 AA for the text tokens (1.4.3: 4.5:1) on every surface text is set on, light and dark. Read from
 * globals.css, so a changed token is checked. Disabled controls are exempt; the reason text beside them is not,
 * and it is set in --fg-3 or --fg-2.
 */

const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8')

function block(selector: string): Record<string, [number, number, number]> {
  const start = css.indexOf(`${selector} {`)
  const end = css.indexOf('\n}', start)
  const tokens: Record<string, [number, number, number]> = {}
  for (const match of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])]
  }
  return tokens
}

const encode = (value: number) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

/** Relative luminance of an OKLCH colour (through linear sRGB, clipped to the gamut). */
function luminance([l, c, h]: [number, number, number]): number {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((value) => linear(encode(Math.min(1, Math.max(0, value)))))
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const SURFACES = ['canvas', 'surface', 'surface-2', 'surface-3', 'accent-soft']
// Text colours and the surfaces they are set on in the UI (found by grepping the text-* and bg-* classes together):
//   fg, fg-2, fg-3: canvas, surface, surface-2, surface-3 (answered tiles, phase chips, fills) and accent-soft.
//   accent (links, check marks, selected labels) and danger (the one error line, error icons): canvas, surface,
//     surface-2. No accent or danger text sits on surface-3; there both are 4.3:1, so a new use there must pick
//     fg or a soft pair instead.
//   warning-soft-fg (late and autosave notes, amber badges): canvas, surface, surface-2, warning-soft.
//   accent-soft-fg, danger-soft-fg, warning-soft-fg, accent-fg and danger-fg: on their own fills (second test).
//   warning (amber) is a graphic only (icons, rings, flags), never text: 3:1 for graphics applies.
const TEXT_ON: Record<string, string[]> = {
  fg: SURFACES,
  'fg-2': SURFACES,
  'fg-3': SURFACES,
  accent: ['canvas', 'surface', 'surface-2'],
  danger: ['canvas', 'surface', 'surface-2'],
  'warning-soft-fg': ['canvas', 'surface', 'surface-2', 'warning-soft'],
}

for (const [mode, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
  test(`${mode}: the map's confirmed and suggested lines reach 3:1 on the canvas and the surface`, () => {
    const tokens = block(selector)
    for (const line of ['edge-confirmed', 'edge-suggested']) {
      for (const surface of ['canvas', 'surface']) {
        const ratio = contrast(tokens[line], tokens[surface])
        assert.ok(ratio >= 3, `${line} on ${surface} is ${ratio.toFixed(2)}:1`)
      }
    }
  })

  test(`${mode}: every text colour reaches 4.5:1 on the surfaces it is set on`, () => {
    const tokens = block(selector)
    const below: string[] = []
    for (const [text, surfaces] of Object.entries(TEXT_ON)) {
      for (const surface of surfaces) {
        const ratio = contrast(tokens[text], tokens[surface])
        if (ratio < 4.5) below.push(`${text} on ${surface} is ${ratio.toFixed(2)}:1`)
      }
    }
    assert.deepEqual(below, [])
  })

  test(`${mode}: text on the accent, soft and status fills reaches 4.5:1`, () => {
    const tokens = block(selector)
    const pairs = [
      ['accent-fg', 'accent'],
      ['accent-soft-fg', 'accent-soft'],
      ['warning-soft-fg', 'warning-soft'],
      ['danger-soft-fg', 'danger-soft'],
      ['danger-fg', 'danger'],
    ]
    for (const [text, fill] of pairs) {
      const ratio = contrast(tokens[text], tokens[fill])
      assert.ok(ratio >= 4.5, `${text} on ${fill} is ${ratio.toFixed(2)}:1`)
    }
  })
}
