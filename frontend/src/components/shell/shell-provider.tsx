'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import type { NavCourse } from '@/server/queries/courses'
import { SlotsProvider } from './slots'

export type ShellUser = { name: string | null; email: string }

type ShellValue = {
  user: ShellUser
  nav: NavCourse[]
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  /** True while any study attempt (quiz, recall, practice, ...) is open. Phones hide the app bar and course tabs then. */
  attemptActive: boolean
  setAttemptCount: React.Dispatch<React.SetStateAction<number>>
}

const ShellContext = React.createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const value = React.useContext(ShellContext)
  if (!value) throw new Error('useShell must be used inside the app shell')
  return value
}

/**
 * Tells the shell that an attempt is open while `active` is true. A counter, so two attempts that overlap for a render
 * (one unmounting as the next mounts) never leave the bar hidden or show it early. Phones then hide the app bar and the
 * course tabs; desktop keeps the sidebar.
 */
export function useShellAttempt(active: boolean) {
  const { setAttemptCount } = useShell()
  React.useEffect(() => {
    if (!active) return
    setAttemptCount((count) => count + 1)
    return () => setAttemptCount((count) => Math.max(0, count - 1))
  }, [active, setAttemptCount])
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Shell state (menus, palette, dialogs), the server-provided nav index, and the global keys. */
export function ShellProvider({
  user,
  nav,
  children,
}: {
  user: ShellUser
  nav: NavCourse[]
  children: React.ReactNode
}) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [attemptCount, setAttemptCount] = React.useState(0)
  const attemptActive = attemptCount > 0
  const pathname = usePathname()

  // The document flag lets CSS drop the bar's height (`--topbar-height`) for sticky offsets while the bar is hidden.
  React.useEffect(() => {
    document.documentElement.toggleAttribute('data-shell-attempt', attemptActive)
    return () => document.documentElement.removeAttribute('data-shell-attempt')
  }, [attemptActive])

  // A navigation closes the mobile menu.
  const [lastPath, setLastPath] = React.useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMobileNavOpen(false)
  }

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
        event.preventDefault()
        setShortcutsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const value = React.useMemo(
    () => ({ user, nav, mobileNavOpen, setMobileNavOpen, paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, attemptActive, setAttemptCount }),
    [user, nav, mobileNavOpen, paletteOpen, shortcutsOpen, attemptActive]
  )

  return (
    <ShellContext.Provider value={value}>
      <SlotsProvider>{children}</SlotsProvider>
    </ShellContext.Provider>
  )
}
