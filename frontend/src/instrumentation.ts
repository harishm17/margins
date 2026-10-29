/**
 * Runs once when the server starts. Unsafe sign-in settings (lib/auth/startup.ts) stop the process:
 * a thrown error here only makes Next log it and answer every request with a 500, so exit instead,
 * which fails the deploy's health check and keeps the old version serving.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { checkAuthStartup } = await import('./lib/auth/startup')
    try {
      checkAuthStartup()
    } catch (error) {
      console.error(`Refusing to start: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
}
