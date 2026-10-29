import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { signInMethods } from '@/lib/auth/auth-config'
import { GOOGLE_SIGN_IN_ERRORS } from '@/lib/auth/google-link'
import { safeNextPath } from '@/lib/safe-redirect'
import { LoginForm } from '@/features/auth/login-form'
import { getSessionUser } from '@/server/session'

export const metadata: Metadata = {
  title: 'Sign in',
  // The one page for signing in and for new accounts, so it is indexed (it was /signup before).
  alternates: { canonical: '/login' },
}

type SearchParams = Promise<{ next?: string; error?: string }>

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, error } = await searchParams
  const target = safeNextPath(next)
  if (await getSessionUser()) redirect(target)

  const initialError = error
    ? (GOOGLE_SIGN_IN_ERRORS[error] ?? 'Something went wrong signing in. Try again.')
    : null

  return (
    <LoginForm
      googleEnabled={signInMethods.google}
      testLoginEnabled={signInMethods.testLogin}
      next={target}
      initialError={initialError}
    />
  )
}
