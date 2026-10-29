'use client'

import Link from 'next/link'
import { InlineAlert } from '@/components/ui/inline-alert'
import { BRAND_NAME } from '@/config/brand'
import { GoogleButton } from './google-button'
import { TestLoginForm } from './test-login-form'

type LoginFormProps = {
  googleEnabled: boolean
  /** The local-only test sign-in (ENABLE_TEST_LOGIN, see lib/auth/test-login.ts). */
  testLoginEnabled: boolean
  /** Where to go after signing in: already checked by safeNextPath. */
  next: string
  /** A message resolved from ?error= on the server. */
  initialError?: string | null
}

/** One page for new and returning students: Google signs in, and makes the account the first time. */
export function LoginForm({ googleEnabled, testLoginEnabled, next, initialError }: LoginFormProps) {
  return (
    <div>
      <h1 className="text-title text-fg">Welcome to {BRAND_NAME}</h1>
      <p className="mt-1.5 text-body text-fg-2">
        New and returning students both continue with Google. Free to use, with a daily AI allowance.
      </p>

      <div className="mt-8 flex flex-col gap-5">
        {initialError ? <InlineAlert tone="danger">{initialError}</InlineAlert> : null}

        {googleEnabled ? (
          <GoogleButton callbackUrl={next} />
        ) : (
          <InlineAlert tone="warning">Google sign-in is not set up on this server.</InlineAlert>
        )}

        <p className="text-small text-fg-2">
          Made your account with a password? Continue with Google using the same email, and your courses will be
          there.
        </p>

        <p className="text-caption font-normal text-fg-3">
          By continuing you agree to the{' '}
          <Link href="/terms" className="underline underline-offset-2 hover:text-fg">
            Terms
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-fg">
            Privacy Policy
          </Link>
          .
        </p>

        {testLoginEnabled ? <TestLoginForm next={next} /> : null}
      </div>
    </div>
  )
}
