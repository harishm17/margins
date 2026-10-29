/* eslint-disable @next/next/no-img-element -- art-directed <picture> built with getImageProps, the pattern the Next docs give for it */
import { getImageProps } from 'next/image'

type Size = { width: number; height: number }

type ShotProps = {
  /** File stem in public/screens: `plan` serves plan-light.webp and plan-dark.webp. */
  name: string
  desktop: Size
  /**
   * A phone-sized version of the same screen (`<name>-mobile-light.webp` ...), used below 768px. It is
   * a real 390px page at its natural size, so the text stays readable.
   */
  mobile?: Size
  alt: string
  sizes: string
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

const THEMES = ['light', 'dark'] as const
export type ShotTheme = (typeof THEMES)[number]

/** The file of one theme's version: `plan` and `dark` give /screens/plan-dark.webp. */
export const shotSrc = (name: string, theme: ShotTheme) => `/screens/${name}-${theme}.webp`

/** The stem of the phone version: `plan` becomes `plan-mobile`, `notes-detail` becomes `notes-detail-mobile`. */
export const mobileStem = (name: string) => `${name}-mobile`

/**
 * A product screenshot in the light or dark version, switched with the theme class on <html>, and
 * optionally a different crop below 768px (art direction with <picture>). Only the visible theme's
 * image is fetched, except for `eager` ones, whose light image is always requested.
 */
export function Shot({ name, desktop, mobile, alt, sizes, desktopMedia = '(min-width: 768px)', eager, className }: ShotProps) {
  return (
    <>
      {THEMES.map((theme) => {
        const priority = eager && theme === 'light'
        const common = { alt, loading: priority ? ('eager' as const) : ('lazy' as const), fetchPriority: priority ? ('high' as const) : ('auto' as const) }
        const wide = getImageProps({ ...common, src: shotSrc(name, theme), ...desktop, sizes })
        const themeClass = theme === 'light' ? 'dark:hidden' : 'hidden dark:block'
        if (!mobile) {
          return <img key={theme} {...wide.props} alt={alt} className={`${themeClass} ${className ?? ''}`} />
        }
        const narrow = getImageProps({ ...common, src: shotSrc(mobileStem(name), theme), ...mobile, sizes: '(min-width: 640px) 390px, calc(100vw - 32px)' })
        return (
          <picture key={theme} className={themeClass}>
            <source media={desktopMedia} srcSet={wide.props.srcSet} sizes={sizes} width={desktop.width} height={desktop.height} />
            <img {...narrow.props} alt={alt} className={className} />
          </picture>
        )
      })}
    </>
  )
}
