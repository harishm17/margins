'use client'

import * as React from 'react'
import { signOut } from 'next-auth/react'
import { SignOut } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { THEME_OPTIONS, useThemeChoice, type ThemeChoice } from '@/components/ui/theme-switch'
import { useAiStatus } from '@/features/ai/ai-status'
import { CONFIRM_WORD, confirmsDeletion } from '@/lib/account/deletion'
import { resetPhrase } from '@/lib/budget/copy'
import { CONTACT_EMAIL } from '@/config/site'
import { deleteAccountAction } from './actions'

/** One settings block: a heading, an optional line under it, and its controls. */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h2 id={id} className="text-heading text-fg">
        {title}
      </h2>
      {description ? <p className="mt-1 max-w-[56ch] text-small text-fg-2">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** The signed-in account: email, how it signs in, and Sign out. */
export function AccountDetails({ email, signInProvider }: { email: string; signInProvider: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-body">
        <dt className="text-fg-2">Email</dt>
        <dd className="truncate text-fg" data-testid="account-email">
          {email}
        </dd>
        <dt className="text-fg-2">Sign-in</dt>
        <dd className="text-fg">{signInProvider === 'google' ? 'Google account' : 'Email and password'}</dd>
      </dl>
      <div>
        <Button icon={<SignOut />} onClick={() => signOut({ callbackUrl: '/login' })}>
          Sign out
        </Button>
      </div>
    </div>
  )
}

/**
 * Today's AI allowance and whether AI features work right now, from the same status the banner and
 * the AI buttons read. Students see a share of the allowance, never dollar amounts.
 */
export function AiAllowance({ timeZone }: { timeZone: string }) {
  const { status, blocked } = useAiStatus()
  const allowance = status.allowance
  const resets = resetPhrase(new Date(), timeZone)
  const percent = allowance?.usedFraction != null ? Math.round(allowance.usedFraction * 100) : null

  return (
    <div className="flex flex-col gap-4">
      {!status.available && blocked ? <InlineAlert tone="warning" title={blocked.title}>{blocked.text}</InlineAlert> : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-body">
        <dt className="text-fg-2">AI features</dt>
        <dd className="text-fg">{status.available ? 'Available' : 'Paused'}</dd>
      </dl>
      {percent !== null ? (
        <div className="flex max-w-[420px] flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4 text-small">
            <span className="text-fg">{allowance?.exhausted ? "You've used today's allowance" : `${percent}% used`}</span>
            <span className="text-fg-2">Resets {resets}</span>
          </div>
          <Progress value={percent} tone={allowance?.exhausted ? 'warning' : 'accent'} aria-label="Today's AI allowance used" />
        </div>
      ) : allowance?.exhausted ? (
        <p className="text-small text-fg">You&apos;ve used today&apos;s AI allowance. It resets {resets}.</p>
      ) : (
        <p className="text-small text-fg-2">No daily limit on this account.</p>
      )}
    </div>
  )
}

/** Light, Dark or System. */
export function ThemeSetting() {
  const { choice, setChoice } = useThemeChoice()
  return (
    <SegmentedControl<ThemeChoice>
      aria-label="Theme"
      value={choice ?? 'system'}
      onValueChange={setChoice}
      options={THEME_OPTIONS.map(({ value, label }) => ({ value, label }))}
    />
  )
}

/** "Delete account": a button, then a dialog that asks for the confirmation word. */
export function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [failed, setFailed] = React.useState(false)

  async function onConfirm() {
    setFailed(false)
    const result = await deleteAccountAction(typed)
    if (!result.ok) {
      if (result.error === 'signed_out') {
        // The session ended meanwhile (the account was deleted in another tab, or it expired).
        await signOut({ callbackUrl: '/login' })
        return
      }
      setFailed(true)
      // Keeps the dialog open, so the student can try again.
      throw new Error(result.error)
    }
    // The server cleared this browser's session cookie; signOut also resets the client and lands
    // on the goodbye page.
    await signOut({ callbackUrl: '/account-deleted' })
  }

  return (
    <>
      <Button
        variant="danger"
        onClick={() => {
          setTyped('')
          setFailed(false)
          setOpen(true)
        }}
      >
        Delete account
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description={
          <>
            This deletes <span className="font-medium text-fg">{email}</span> and everything in it. Type {CONFIRM_WORD}{' '}
            to confirm.
          </>
        }
        confirmLabel="Delete account"
        destructive
        confirmDisabled={!confirmsDeletion(typed)}
        onConfirm={onConfirm}
      >
        <div className="flex flex-col gap-4">
          <Field label={`Type "${CONFIRM_WORD}"`}>
            <Input
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          {failed ? (
            <InlineAlert tone="danger">
              Your account couldn&apos;t be deleted completely. Try again. If it keeps failing, email {CONTACT_EMAIL}.
            </InlineAlert>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  )
}
