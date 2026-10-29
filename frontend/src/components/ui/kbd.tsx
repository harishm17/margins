import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Keyboard hints are noise on a touch-first device (its main pointer is coarse: a phone or a tablet
 * without a trackpad), so every hint hides there. This one class is the rule; `Kbd`, `KeyHint` and the
 * menu item hint all use it.
 */
export const KEY_HINT_HIDDEN = 'pointer-coarse:hidden'

type KbdProps = ComponentProps<'kbd'> & {
  /**
   * Show it on touch devices too. Only for places that exist to list keys and that only a keyboard
   * opens (the shortcuts dialog), where hiding the keys would empty the content.
   */
  persistent?: boolean
}

/** A key, as a hint. Hidden on touch-first devices unless `persistent`. */
export function Kbd({ className, persistent = false, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-2 px-1 font-mono text-[11.5px] leading-none text-fg-2',
        !persistent && KEY_HINT_HIDDEN,
        className
      )}
      {...props}
    />
  )
}

/** A group that only makes sense with a keyboard ("Up Down Navigate"): keys and their words hide together on touch-first devices. */
export function KeyHint({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn(KEY_HINT_HIDDEN, className)} {...props} />
}
