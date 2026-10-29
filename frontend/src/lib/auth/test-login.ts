import { isLoopbackHost, notLocalReason, type Env } from './site'

/**
 * The test sign-in: an email with no password, for the e2e specs, the screenshot script and local
 * development. It signs anyone in as anyone it accepts, so it is fenced four ways:
 *
 * 1. It is off unless ENABLE_TEST_LOGIN is exactly "true".
 * 2. Even then it is only built when the site is local (NEXTAUTH_URL on this machine, not Railway),
 *    and the server refuses to start if the variable is set on any other site (startup.ts).
 * 3. Each sign-in checks the request came to a loopback host.
 * 4. It only accepts @example.com addresses, a domain nobody can receive mail at, so no Google
 *    account (and no real student) can ever have one.
 */
export const TEST_LOGIN_PROVIDER_ID = 'test-login'

const TEST_EMAIL = /^[^\s@]+@example\.com$/i

/** Whether ENABLE_TEST_LOGIN asks for the test sign-in, with any value other than off. */
export function testLoginRequested(env: Env): boolean {
  const value = env.ENABLE_TEST_LOGIN?.trim().toLowerCase() ?? ''
  return value !== '' && value !== 'false' && value !== '0'
}

/** Why the test sign-in may not run here, or null when it may. */
export function testLoginBlocker(env: Env): string | null {
  return notLocalReason(env)
}

export function isTestLoginEnabled(env: Env): boolean {
  return env.ENABLE_TEST_LOGIN === 'true' && testLoginBlocker(env) === null
}

export function isTestLoginEmail(email: string): boolean {
  return TEST_EMAIL.test(email)
}

/** Each sign-in also checks the Host header: a proxy or tunnel in front of the server fails it. */
export function isLocalRequest(headers: Record<string, unknown> | undefined): boolean {
  const host = headers?.host
  const forwarded = headers?.['x-forwarded-host']
  if (typeof host !== 'string' || !isLoopbackHost(host)) return false
  return forwarded === undefined || (typeof forwarded === 'string' && isLoopbackHost(forwarded))
}
