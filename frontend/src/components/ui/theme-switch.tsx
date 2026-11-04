'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { Check, Monitor, Moon, Sun } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { menuItem } from './styles'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu'
import { IconButton } from './icon-button'

export type ThemeChoice = 'light' | 'dark' | 'system'

export const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const satisfies readonly { value: ThemeChoice; label: string; icon: React.ElementType }[]

const subscribe = () => () => {}

/**
 * The student's theme choice (next-themes owns the storage and the class on <html>).
 * `choice` is null on the server and during hydration, so nothing renders a stale state.
 */
export function useThemeChoice(): { choice: ThemeChoice | null; setChoice: (choice: ThemeChoice) => void } {
  const { theme, setTheme } = useTheme()
  const mounted = React.useSyncExternalStore(subscribe, () => true, () => false)
  const choice = mounted ? ((theme as ThemeChoice | undefined) ?? 'system') : null
  return { choice, setChoice: setTheme }
}

/**
 * The theme control for pages without the app's account menu (the public pages, sign in and sign
 * up): an icon button that opens Light, Dark and System. The icon follows the theme class on
 * <html> through CSS, so the server and the browser render the same markup. Inside the signed-in
 * account menu the same choices are `ThemeMenuRadios`; both read and write the theme through
 * `useThemeChoice`.
 */
export function ThemeSwitch({ align = 'end' }: { align?: 'start' | 'center' | 'end' }) {
  const { choice, setChoice } = useThemeChoice()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="Theme"
          noTooltip
          icon={
            <>
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
            </>
          }
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[160px]">
        <DropdownMenuRadioGroup value={choice ?? 'system'} onValueChange={(next) => setChoice(next as ThemeChoice)}>
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" className="mr-2 inline size-4 align-[-3px] text-fg-3" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The same three choices as a row of menu items, for a dropdown menu: always visible (not behind
 * a submenu), reachable with the arrow keys, and the menu stays open so the page can be seen
 * changing.
 */
export function ThemeMenuRadios({ className }: { className?: string }) {
  const { choice, setChoice } = useThemeChoice()
  return (
    <MenuPrimitive.RadioGroup
      aria-label="Theme"
      value={choice ?? 'system'}
      onValueChange={(next) => setChoice(next as ThemeChoice)}
      className={cn('grid grid-cols-3 gap-1 px-0.5 pb-0.5', className)}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <MenuPrimitive.RadioItem
          key={value}
          value={value}
          onSelect={(event) => event.preventDefault()}
          className={cn(
            menuItem,
            'min-h-14 max-sm:min-h-14 flex-col justify-center gap-1 px-1 text-small',
            'data-[state=checked]:bg-accent-soft data-[state=checked]:text-accent-soft-fg'
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
          <MenuPrimitive.ItemIndicator className="absolute right-1 top-1 inline-flex">
            <Check weight="bold" aria-hidden="true" className="size-3 text-accent-soft-fg" />
          </MenuPrimitive.ItemIndicator>
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  )
}
