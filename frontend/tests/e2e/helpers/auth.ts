import { expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Sign-in for the specs. Students sign in with Google only, which a test cannot do, so the e2e stack
 * runs with ENABLE_TEST_LOGIN=true (scripts/e2e-stack.sh) and the specs use the local-only test
 * sign-in on /login (src/lib/auth/test-login.ts). The first sign-in with an address makes the
 * account. Only @example.com addresses are accepted.
 */

/** Fills the test sign-in on the login page that is already open (keeps its ?next=). */
export async function submitTestLogin(page: Page, email: string) {
  const form = page.getByRole('form', { name: 'Test sign-in' })
  await form.getByLabel('Email').fill(email)
  await form.getByRole('button', { name: 'Test sign-in' }).click()
}

/** Opens /login, signs in as `email` (making the account the first time) and waits for Home. */
export async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await submitTestLogin(page, email)
  await expect(page).toHaveURL(/\/home$/, { timeout: 60_000 })
}

/** The same sign-in through the API, for request contexts with no page (the demo seed). */
export async function signInApi(api: APIRequestContext, email: string, name?: string) {
  const csrf = await api.get('/api/auth/csrf')
  const { csrfToken } = (await csrf.json()) as { csrfToken: string }
  await api.post('/api/auth/callback/test-login', { form: { csrfToken, email, name: name ?? '', json: 'true' } })
  const session = (await (await api.get('/api/auth/session')).json()) as { user?: { email?: string } }
  if (session.user?.email !== email.toLowerCase()) {
    throw new Error(`the test sign-in did not sign in ${email}: is the stack running with ENABLE_TEST_LOGIN=true?`)
  }
}
