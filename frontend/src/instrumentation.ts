/**
 * Runs once when the server starts. Unsafe sign-in settings (lib/auth/startup.ts) stop the process:
 * a thrown error here only makes Next log it and answer every request with a 500, so exit instead,
 * which fails the deploy's health check and keeps the old version serving.
 */
import { logServerError } from '@/lib/ops/log'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { activePromptAreas } = await import('./lib/prompt-revision')
    // Both services log their active prompt areas at start (R9); the voice flag must be the same in both.
    console.log(`prompts_v2 ${activePromptAreas()}`)
    const { checkAuthStartup } = await import('./lib/auth/startup')
    try {
      checkAuthStartup()
    } catch (error) {
      // The message names the unsafe setting, never user data, and the operator needs it to fix the deploy.
      // eslint-disable-next-line no-restricted-syntax
      console.error(`Refusing to start: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    // Accounts made before spend keys get theirs (and the ledger rows they own are stamped). Not needed to serve
    // requests, which compute a missing key on demand, so a failure is logged and the server carries on.
    import('./lib/account/spend-key-backfill')
      .then(({ backfillSpendKeys }) => backfillSpendKeys())
      .then(({ users }) => users > 0 && console.log(`Gave ${users} existing account(s) their spend key`))
      .catch((error) => logServerError('Spend key backfill failed', error))
  }
}
