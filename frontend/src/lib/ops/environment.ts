export const ENVIRONMENTS = ['development', 'test', 'production'] as const
export type AppEnvironment = (typeof ENVIRONMENTS)[number]

/**
 * Which deployment this server is: the ENVIRONMENT setting, which the AI service reads too. There is no default
 * (SEC-L2): a server that was not told where it runs must not start as a development one. A server running a
 * production build (NODE_ENV=production) throws on a missing or misspelt value; `next dev` and the unit tests may
 * leave it unset, which gives null.
 */
export function resolveEnvironment(env: Record<string, string | undefined> = process.env): AppEnvironment | null {
  const value = env.ENVIRONMENT
  if ((ENVIRONMENTS as readonly string[]).includes(value ?? '')) return value as AppEnvironment
  if (value === undefined || value === '') {
    if (env.NODE_ENV !== 'production') return null
    throw new Error(`ENVIRONMENT is not set. Set it to one of ${ENVIRONMENTS.join(', ')}; there is no default.`)
  }
  throw new Error(`ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')}, spelt exactly.`)
}
