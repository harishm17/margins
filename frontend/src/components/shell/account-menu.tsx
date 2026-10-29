'use client'

import { signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { CaretUpDown, GearSix, SignOut } from '@phosphor-icons/react/dist/ssr'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ThemeMenuRadios } from '@/components/ui/theme-switch'
import { Tooltip } from '@/components/ui/tooltip'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useShell } from './shell-provider'

export function Avatar({ name, email, className }: { name: string | null; email: string; className?: string }) {
  return (
    // The initials are drawn from an attribute, so they are not part of the button's text: the
    // visible text of the account menu is the name alone, which its accessible name then contains.
    <span
      aria-hidden="true"
      data-initials={initials(name, email)}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-caption text-accent-soft-fg',
        'before:content-[attr(data-initials)]',
        className
      )}
    />
  )
}

/** Avatar, name and a menu: email, Settings, theme (System, Light, Dark), sign out. */
export function AccountMenu({ rail }: { rail?: boolean }) {
  const { user } = useShell()
  const router = useRouter()
  const label = user.name || user.email

  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        // The name starts with the visible text (WCAG 2.5.3), then says what the button is.
        aria-label={`${label}, account menu`}
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-control px-2 text-left text-body-strong text-fg',
          'transition-colors duration-120 hover:bg-surface-2 data-[state=open]:bg-surface-2',
          'rail:justify-center rail:px-0'
        )}
      >
        <Avatar name={user.name} email={user.email} />
        <span className="min-w-0 flex-1 truncate rail:hidden">{label}</span>
        <CaretUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-3 rail:hidden" />
      </button>
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu>
      {rail ? (
        <Tooltip content={label} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent side="top" align="start" className="min-w-[232px]">
        <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        <DropdownMenuItem icon={<GearSix />} onSelect={() => router.push('/settings')}>
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <ThemeMenuRadios />
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<SignOut />} onSelect={() => signOut({ callbackUrl: '/login' })}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
