'use client'

import * as React from 'react'
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

// Sonner's own phone rule is `max-width: 600px` (600 included), so a 600px window gets its mobile offsets and must get the top position too.
const PHONE_QUERY = '(max-width: 600px)'
const subscribePhone = (notify: () => void) => {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

/**
 * On a phone toasts come in under the top bar, not above the tab bar: the primary action of a screen (Next question,
 * Check my answer) sits just above the bar, and a toast over it hides what the student is about to tap.
 */
const usePhone = () => React.useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false)

/** Transient confirmations and failures of background actions. Never for form validation. */
export function Toaster() {
  const { resolvedTheme } = useTheme()
  const phone = usePhone()
  return (
    <Sonner
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position={phone ? 'top-center' : 'bottom-right'}
      visibleToasts={3}
      duration={4000}
      closeButton={false}
      offset={{ bottom: BOTTOM, right: 24 }}
      mobileOffset={{ top: 'calc(var(--topbar-height) + 8px)', left: 16, right: 16 }}
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
