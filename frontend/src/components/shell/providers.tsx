'use client'

import * as React from 'react'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/toaster'
import { NarrowScreenCookie } from '@/features/shell/narrow-screen-cookie'
import { TimeZoneCookie } from '@/features/shell/time-zone-sync'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InAppNavigationRecorder } from './in-app-navigation'

/** Theme (System, Light, Dark; class on <html>), tooltips and toasts for the whole app. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster />
      <TimeZoneCookie />
      <NarrowScreenCookie />
      <InAppNavigationRecorder />
    </ThemeProvider>
  )
}
