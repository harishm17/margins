'use client'

import { Toaster as Sonner, toast } from 'sonner'
import { useTheme } from 'next-themes'
import { LAYERS } from '@/config/layers'

export { toast }

/**
 * The gap under the toasts: 16px above the mobile tab bar where there is one (its height already
 * holds the device's safe area, see mobile-tabs.tsx), otherwise 16px above the safe area. Sonner uses
 * `offset` from 600px and `mobileOffset` below it; the tab bar shows up to 1024px, so both need it.
 */
const BOTTOM = 'calc(var(--tabbar-height, env(safe-area-inset-bottom, 0px)) + 16px)'

/**
 * The icon takes the colour of the toast's kind, so a failure never shows the success green. The
 * toast element carries `data-type`.
 */
const ICON_TONE = [
  'in-data-[type=success]:text-accent',
  'in-data-[type=error]:text-danger',
  'in-data-[type=warning]:text-warning',
  'in-data-[type=info]:text-fg-3',
].join(' ')

/** Transient confirmations and failures of background actions. Never for form validation. */
export function Toaster() {
  const { resolvedTheme } = useTheme()
  return (
    <Sonner
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      visibleToasts={3}
      duration={4000}
      closeButton={false}
      offset={{ bottom: BOTTOM, right: 24 }}
      mobileOffset={{ bottom: BOTTOM, left: 16, right: 16 }}
      style={
        {
          zIndex: LAYERS.toast,
          '--normal-bg': 'var(--surface)',
          '--normal-text': 'var(--fg)',
          '--normal-border': 'var(--border)',
          '--border-radius': '12px',
          '--success-bg': 'var(--surface)',
          '--success-text': 'var(--fg)',
          '--success-border': 'var(--border)',
          '--error-bg': 'var(--surface)',
          '--error-text': 'var(--danger-soft-fg)',
          '--error-border': 'var(--border)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: '!shadow-float !font-sans !text-small',
          icon: ICON_TONE,
        },
      }}
    />
  )
}
