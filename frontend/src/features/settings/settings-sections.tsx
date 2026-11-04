'use client'

import * as React from 'react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { CaretDown, SignOut } from '@phosphor-icons/react/dist/ssr'
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
import { allowanceView } from './allowance'
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
        {/* A long address wraps (and can be selected whole) instead of being cut off with an ellipsis. */}
        <dd className="min-w-0 select-text text-fg wrap-anywhere" data-testid="account-email">
          {email}
        </dd>
        <dt className="text-fg-2">Sign-in</dt>
        <dd className="text-fg">{signInProvider === 'google' ? 'Google account' : 'Test sign-in (this computer only)'}</dd>
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
  const view = allowanceView(status.allowance)
  const resets = resetPhrase(new Date(), timeZone)

  return (
    <div className="flex flex-col gap-4">
      {!status.available && blocked ? <InlineAlert tone="warning" title={blocked.title}>{blocked.text}</InlineAlert> : null}
      {/* The answer first: whether AI works, how much of today is used and when it resets. How it is counted is a click away. */}
      <p className="flex flex-wrap items-baseline gap-x-2 text-body text-fg" data-testid="allowance-summary">
        <span>{status.available ? 'Available' : 'Paused'}</span>
        <span aria-hidden="true" className="text-fg-3">·</span>
        {view.kind === 'used' ? (
          <>
            <span>{view.exhausted ? "Today's allowance used" : `${view.percent}% used`}</span>
            <span aria-hidden="true" className="text-fg-3">·</span>
            <span className="text-fg-2">resets {resets}</span>
          </>
        ) : view.kind === 'exhausted' ? (
          <>
            <span>Today&apos;s allowance used</span>
            <span aria-hidden="true" className="text-fg-3">·</span>
            <span className="text-fg-2">resets {resets}</span>
          </>
        ) : view.kind === 'unlimited' ? (
          <span className="text-fg-2">No daily limit on this account</span>
        ) : (
          <span className="text-fg-2">Allowance can&apos;t be shown right now</span>
        )}
      </p>
      {view.kind === 'used' ? (
        <Progress value={view.percent} tone={view.exhausted ? 'warning' : 'accent'} aria-label="Today's AI allowance used" className="max-w-[420px]" />
      ) : null}
      <details className="group text-small text-fg-2">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip text-fg-2 hover:text-fg max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
          How the allowance works
          <CaretDown aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-180" />
        </summary>
        <p className="mt-2 max-w-[56ch]" data-testid="allowance-explainer">
          Different actions use different amounts, so the percentage is a share of the day&apos;s allowance, not a count of questions left. When it
          runs out, new notes, quizzes and answers wait until it resets; what is already written stays readable.{' '}
          <Link href="/#faq" target="_blank" rel="noopener noreferrer" className="rounded-chip text-accent underline underline-offset-2 hover:text-accent-hover max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
            What happens at the limit
          </Link>
        </p>
      </details>
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
      {/* Quiet until the dialog: the red filled button is the one that confirms. Red text says what it is without out-shouting the page's real actions. */}
      <Button
        variant="secondary"
        className="text-danger-soft-fg"
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
            This permanently deletes <span className="font-medium text-fg wrap-anywhere">{email}</span> and all courses, files, study content
            and progress. Enter {CONFIRM_WORD} to confirm.
          </>
        }
        confirmLabel="Delete account"
        destructive
        confirmDisabled={!confirmsDeletion(typed)}
        confirmDisabledReason={`Enter ${CONFIRM_WORD} to confirm.`}
        onConfirm={onConfirm}
      >
        <div className="flex flex-col gap-4">
          <Field label="Confirmation" hint={`Enter ${CONFIRM_WORD} to confirm`}>
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
