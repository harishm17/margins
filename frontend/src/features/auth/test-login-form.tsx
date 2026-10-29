'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'

/**
 * The local-only test sign-in, for the e2e specs, the screenshot script and local development. The
 * server only offers it when lib/auth/test-login.ts allows it; students never see it.
 */
export function TestLoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const result = await signIn('test-login', { email: email.trim(), redirect: false })
      if (!result || result.error) throw new Error('refused')
      router.push(next)
      router.refresh()
    } catch {
      setError('Use an @example.com address.')
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label="Test sign-in"
      className="flex flex-col gap-4 rounded-card border border-dashed border-border p-4"
    >
      <p className="text-caption font-normal text-fg-3">
        Test sign-in for this local server: any @example.com address, no password.
      </p>
      <Field label="Email">
        <Input
          type="email"
          name="email"
          autoComplete="off"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <Button type="submit" variant="secondary" fullWidth loading={pending}>
        Test sign-in
      </Button>
    </form>
  )
}
