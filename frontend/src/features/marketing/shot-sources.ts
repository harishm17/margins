/**
 * Where a product screenshot's files are, how big they are, and how wide the site draws them.
 *
 * `npm run screens` (scripts/capture-screens.ts) writes every screen at a few widths into public/screens
 * (`plan-light-960.webp`, `plan-light-1920.webp` ...) and lists them in screens.json. Shot serves those files as
 * they are, with no second encode, through `srcset`; the browser picks a width from the `sizes` below.
 */

/** One screen (the light and dark versions are the same size): the widths written, and the largest file's size. */
export type ScreenEntry = { widths: number[]; width: number; height: number }
export type ScreensManifest = Record<string, ScreenEntry>
export type ShotTheme = 'light' | 'dark'

/** The file of one version at one width: `plan`, `dark`, 1920 give /screens/plan-dark-1920.webp. */
export const screenFile = (stem: string, theme: ShotTheme, width: number) => `/screens/${stem}-${theme}-${width}.webp`

/** The stem of the phone version: `plan` becomes `plan-mobile`, `notes-detail` becomes `notes-detail-mobile`. */
export const mobileStem = (name: string) => `${name}-mobile`

/**
 * The `src`, `srcSet` (one `w` descriptor per width) and intrinsic size of one version of a screen. `src`, for
 * anything that ignores srcset, is the second-smallest width (2x of a typical slot).
 */
export function shotSources(manifest: ScreensManifest, stem: string, theme: ShotTheme) {
  const entry = manifest[stem]
  if (!entry || entry.widths.length === 0) throw new Error(`No screenshot "${stem}" in screens.json: run npm run screens`)
  const widths = [...entry.widths].sort((a, b) => a - b)
  return {
    src: screenFile(stem, theme, widths[Math.min(1, widths.length - 1)]),
    srcSet: widths.map((width) => `${screenFile(stem, theme, width)} ${width}w`).join(', '),
    width: entry.width,
    height: entry.height,
  }
}

/**
 * The CSS width of each slot a screenshot is drawn in, as a `sizes` value, worked out from the layout classes
 * (the 1280px container with 32px padding from 768px and 16px below, the grid columns and gaps, 1px borders)
 * and checked against the widths measured in a browser at 390-1920px (shot-sources.test.ts).
 */
export const SLOT_SIZES = {
  /** Hero, desktop crop: the 7fr column beside the 4fr headline from 1024px, the full container from 768px. */
  hero: '(min-width: 1280px) 741px, (min-width: 1024px) calc((100vw - 112px) * 7 / 11 - 2px), calc(100vw - 66px)',
  /** How it works from 1024px: the 7fr column beside the 5fr step list, in a 4:3 frame. */
  loopPanel: '(min-width: 1280px) 679px, calc((100vw - 112px) * 7 / 12 - 2px)',
  /** How it works at 768-1023px: each step's desktop crop at the container's width. */
  loopList: 'calc(100vw - 66px)',
  /** Sources you can check: the 7-of-12 card (32px gaps) less its 32px padding, or the full card below 1024px. */
  ask: '(min-width: 1280px) 628px, (min-width: 1024px) calc((100vw - 416px) * 7 / 12 + 124px), calc(100vw - 132px)',
  /** Sources you can check below 768px: the card less its 24px padding. */
  askPhone: 'calc(100vw - 84px)',
  /** Any phone version in a frame of at most 420px, 16px from each edge of the page. */
  phone: '(min-width: 452px) 418px, calc(100vw - 34px)',
  /** The sign-in and sign-up panel from 1024px: beside the 480px form column, inside 16px and 40px (56px from 1280px) of padding. */
  auth: '(min-width: 1280px) calc(100vw - 626px), calc(100vw - 594px)',
} as const
