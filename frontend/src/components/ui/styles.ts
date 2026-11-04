/** Class strings shared by several primitives, so they stay identical. */

/** Floating surfaces: popover, dropdown, select, hover card. */
export const floatingSurface =
  'z-popper rounded-card border border-border bg-surface text-fg shadow-float'

/** Enter and leave animation for Radix popper content (uses its transform origin variable). */
export const popperMotion =
  'origin-(--radix-popper-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out'

/**
 * The phone hit-target contract. Below the `sm` breakpoint (640px) every control a finger can press
 * is at least 44px tall; from `sm` up it keeps its compact desktop size. Button, IconButton, Input,
 * Select, SegmentedControl, Tabs and menu rows follow it with `max-sm:h-11` or `max-sm:min-h-11`;
 * a feature that draws its own control uses these strings instead of choosing a number.
 */
/** A row that is its own box (a link or button in a list or footer): 44px on a phone, centred text. */
export const phoneRow = 'max-sm:flex max-sm:min-h-11 max-sm:items-center'
/** An inline link inside a sentence: the text stays put, an invisible 44px strip on a phone is the hit area. */
export const phoneInlineHit =
  'relative max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:top-1/2 max-sm:after:h-11 max-sm:after:-translate-y-1/2 max-sm:after:content-[""]'
/** A link that stands on its own line or beside other links (not inside a sentence): a real 44px box on a phone. */
export const phoneStandaloneLink = 'max-sm:min-h-11 max-sm:items-center'
/** Entry text is 16px on a phone, so iOS does not zoom the page when a field gets focus. */
export const phoneEntryText = 'max-sm:text-[16px]'

/** A row in a menu or list box. */
export const menuItem =
  'relative flex min-h-8 max-sm:min-h-11 cursor-default select-none items-center gap-2 rounded-control px-2.5 py-1.5 text-[13.5px] leading-5 outline-none data-[disabled]:pointer-events-none data-[disabled]:text-fg-3 data-[highlighted]:bg-surface-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3'

/*
 * Disabled is drawn with explicit tokens, not by fading the enabled look: a faded accent button was 1.7:1
 * in the light theme. A disabled button is a flat grey fill (surface-3) with meta text (fg-3), which is
 * 4.6:1 in light and 4.7:1 in dark, with no border and no hover change, so it reads as "not available"
 * and its label stays readable. The "!" keeps the hover and focus colours from winning over it.
 * Disabled links and ghost buttons have no fill, only the meta text colour.
 */
export const DISABLED_FILL =
  'disabled:border-transparent disabled:bg-surface-3! disabled:text-fg-3! aria-disabled:border-transparent aria-disabled:bg-surface-3! aria-disabled:text-fg-3!'
export const DISABLED_TEXT = 'disabled:bg-transparent! disabled:text-fg-3! aria-disabled:bg-transparent! aria-disabled:text-fg-3!'
