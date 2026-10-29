/* eslint-disable @next/next/no-img-element -- the screenshots are written at the widths they need (npm run screens) and served as they are, without the image optimizer's second, lossy encode */
import SCREENS from './screens.json'
import { SLOT_SIZES, mobileStem, shotSources, type ScreensManifest, type ShotTheme } from './shot-sources'

type ShotProps = {
  /** File stem in public/screens: `plan` serves plan-light-<width>.webp and plan-dark-<width>.webp. */
  name: string
  /**
   * Use the phone-sized version of the same screen (`<name>-mobile-light-<width>.webp` ...) below `desktopMedia`.
   * It is a real 390px page at its natural size, so the text stays readable.
   */
  mobile?: boolean
  alt: string
  /** The width the desktop version is drawn at (SLOT_SIZES). */
  sizes: string
  /** The width the phone version is drawn at. Default: a frame of at most 420px (SLOT_SIZES.phone). */
  mobileSizes?: string
  /**
   * The media query that picks the desktop crop over the phone one. Default: 768px and up. A block that is
   * hidden above some width should stop at it (`(min-width: 768px) and (max-width: 1023px)`), so the hidden
   * block never requests the desktop image.
   */
  desktopMedia?: string
  /** Fetch the light version at once and with high priority: for the first image on the page. */
  eager?: boolean
  className?: string
}

const THEMES: ShotTheme[] = ['light', 'dark']

/**
 * A product screenshot in the light or dark version, switched with the theme class on <html>, and
 * optionally a different crop below 768px (art direction with <picture>). Only the visible theme's
 * image is fetched, except for `eager` ones, whose light image is always requested.
 */
export function Shot({ name, mobile, alt, sizes, mobileSizes = SLOT_SIZES.phone, desktopMedia = '(min-width: 768px)', eager, className }: ShotProps) {
  const screens = SCREENS as ScreensManifest
  return (
    <>
      {THEMES.map((theme) => {
        const priority = eager && theme === 'light'
        // React sets attributes in order: `loading` first and `src` last, as next/image does, or Safari and Firefox
        // fetch `src` before they know the image is lazy and before `srcSet` and `sizes` are set
        // (facebook/react#25883).
        const common = {
          alt,
          loading: priority ? ('eager' as const) : ('lazy' as const),
          fetchPriority: priority ? ('high' as const) : ('auto' as const),
          decoding: 'async' as const,
        }
        const wide = shotSources(screens, name, theme)
        const themeClass = theme === 'light' ? 'dark:hidden' : 'hidden dark:block'
        if (mobile) {
          const narrow = shotSources(screens, mobileStem(name), theme)
          return (
            <picture key={theme} className={themeClass}>
              <source media={desktopMedia} srcSet={wide.srcSet} sizes={sizes} width={wide.width} height={wide.height} />
              <img {...common} srcSet={narrow.srcSet} sizes={mobileSizes} width={narrow.width} height={narrow.height} className={className} src={narrow.src} />
            </picture>
          )
        }
        return (
          <img
            key={theme}
            {...common}
            srcSet={wide.srcSet}
            sizes={sizes}
            width={wide.width}
            height={wide.height}
            className={`${themeClass} ${className ?? ''}`}
            src={wide.src}
          />
        )
      })}
    </>
  )
}
